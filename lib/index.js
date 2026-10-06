/**
 * dsh-team-member-routes — per-teammate LLM routes for Agent Teams.
 *
 * Three capabilities, all built on official mechanisms (the official Team spawn
 * path, `ApiSessionAgentController.selectForNextRequest`, and the official
 * `ModelSelect` component):
 *
 * 1. `spawn_teammate_route` (host) — the Lead creates a teammate with its own
 *    provider/model/reasoning_effort instead of inheriting the Lead's route.
 * 2. `set_teammate_model` (host) — the Lead re-routes an EXISTING teammate that
 *    is NOT working (idle / inactive). A running or provisioning teammate is
 *    refused: one in-flight turn must not split across two models. The route is
 *    durable and survives DSH restarts.
 * 3. `lib/client.js` (client) — restores the official model picker and the
 *    reasoning-effort picker inside a teammate's own composer, so the same change
 *    can be made by clicking instead of by tool call. Its `selectModel` RPC lands
 *    on the host-side patch below.
 *
 * Verified against DSH 0.1.6-alpha.1 (markers confirmed in the running
 * app.asar).
 *
 * Why the stock UI cannot do this (two independent gates):
 *   - Client: the composer model picker and `/model` are gated on
 *     `sessions.subagentAddress(sessionId) === void 0`
 *     (dsh-client-ui-model-selection/lib/client.js L926, L951); an addressed
 *     subagent session is therefore rendered without any selector.
 *   - Host: `SessionController.selectModel` resolves the Agent through
 *     `ApiSessionAgentController.resolveAgent`, which refuses any session whose
 *     header carries `origin === "subagent"` via `hasApiSessionSubagentOwner`
 *     (dsh-api-session-controller/lib/index.js L125-131, L268, L606) with
 *     `session/agent-busy` ("owned by subagent routing").
 *   - Teammate routing is additionally frozen at creation: the first
 *     `subagent/descriptor` event is authoritative (`foldSubagentDescriptor`
 *     uses `events.find(...)`, dsh-subagent/lib/index.js L1418-1434) and cold
 *     resume rebuilds AgentOptions from it (L1901-1905).
 *
 * How this plugin routes a teammate instead:
 *   - A durable per-session route store (~/.dsh/team-member-routes.json) is the
 *     single source of truth for post-hoc changes.
 *   - `agents.create` / `agents.resume` are wrapped at instance level so a
 *     stored route overrides `spec.agentOptions` at materialization; that is the
 *     seam both `startContinuable` (creation) and `resumeContinuable` (cold
 *     resume) pass through, so a re-routed teammate keeps its model after a
 *     restart without rewriting its descriptor.
 *   - For a live teammate, `sessionController.agents.selectForNextRequest`
 *     installs/updates the Session-local selection, which appends a durable
 *     `model/selection` event and overrides the next request through the
 *     official `installModelSelection` waterfall (dsh-agent/lib/index.js
 *     L133-177). `agent.options` is aligned so `list_agents` and the Team panel
 *     report the actual model.
 *   - `sessionController.selectModel` is wrapped to fall back to that same path
 *     when the official call refuses for subagent ownership, so a future
 *     composer-side selector works without further host changes.
 *
 * Preflight reuses the official primitive `llm.resolveCallConfig` and runs
 * BEFORE any roster write, so an invalid route fails with a clean roster.
 *
 * Deliberately raw tool definitions (no `@deepseek-ai/*` imports): the plugin is
 * mounted through a pnpm `link:` dependency, and Node resolves bare specifiers
 * from the workspace checkout rather than the DSH bundle, so an official import
 * would fail (verified: ERR_MODULE_NOT_FOUND). Same constraint as the
 * graph-memory plugin. Definitions satisfy the dsh-tools raw subset directly:
 * `{ name, description, parameters, output:{schema,render}, execute }`, where
 * `parameters` is a complete JSON Schema (NOT the property-map DSL).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

/** Cordis plugin name. */
export const name = "team-member-routes";

/** Services required at apply time. */
export const inject = ["agentTeams", "subagents", "tools", "agents", "llm"];

/** Member row shape: mirrors the official TeamMemberView (tool-agent-team L35-76). */
const MEMBER_VIEW_SCHEMA = {
	type: "object",
	additionalProperties: false,
	properties: {
		id: { type: "string" },
		name: { type: "string" },
		role: { type: "string", enum: ["lead", "teammate"] },
		status: {
			type: "string",
			enum: ["running", "idle", "inactive", "provisioning", "failed"]
		},
		description: { type: "string" },
		provider: { type: "string" },
		context: { type: "string", enum: ["fresh", "fork"] },
		model: { type: "string" },
		diagnostics: { type: "array", items: { type: "string" } }
	},
	required: ["id", "name", "role", "status", "description", "provider", "context", "diagnostics"]
};

const SPAWN_VALUE_SCHEMA = {
	type: "object",
	additionalProperties: false,
	properties: { member: MEMBER_VIEW_SCHEMA },
	required: ["member"]
};

/** Result of one explicit re-route: the applied route plus how it was applied. */
const SET_MODEL_VALUE_SCHEMA = {
	type: "object",
	additionalProperties: false,
	properties: {
		member: MEMBER_VIEW_SCHEMA,
		route: {
			type: "object",
			additionalProperties: false,
			properties: {
				provider: { type: "string" },
				model: { type: "string" },
				reasoningEffort: { type: "string" }
			},
			required: ["provider", "model"]
		},
		applied: { type: "string", enum: ["live", "durable"] },
		note: { type: "string" }
	},
	required: ["member", "route", "applied"]
};

/** Official jsonOutput render: the model sees the exact canonical value. */
function jsonRender(_args, value) {
	return [{ type: "text", text: JSON.stringify(value) }];
}

/** One-line identity reminder, byte-identical to the official spawn_teammate (tool-agent-team L275-281). */
function identityReminder(trimmedName) {
	return `<system-reminder>\nYou are teammate "${trimmedName}".\n</system-reminder>\n\n`;
}

/** Bounded single-line description of a thrown value. */
function errorText(error) {
	if (error instanceof Error) return error.message;
	if (typeof error === "string") return error;
	try {
		return JSON.stringify(error);
	} catch {
		return String(error);
	}
}

/** Pending-route key: Lead session id + teammate description (the startContinuable label). */
function pendingKey(parentId, label) {
	return `${parentId}\u0000${label}`;
}

/** FIFO enqueue so concurrent same-key spawns are consumed in order. */
function pendingEnqueue(pending, key, route) {
	const queue = pending.get(key);
	if (queue === undefined) pending.set(key, [route]);
	else queue.push(route);
}

/** Take the oldest pending route for a key, dropping the queue when drained. */
function pendingTake(pending, key) {
	const queue = pending.get(key);
	if (queue === undefined) return undefined;
	const route = queue.shift();
	if (queue.length === 0) pending.delete(key);
	return route;
}

/** Remove one specific route (cleanup when the official spawn never reached startContinuable). */
function pendingRemove(pending, key, route) {
	const queue = pending.get(key);
	if (queue === undefined) return;
	const index = queue.indexOf(route);
	if (index >= 0) queue.splice(index, 1);
	if (queue.length === 0) pending.delete(key);
}

/**
 * Resolve the Harness home the same way `@deepseek-ai/dsh-home-paths` does
 * (precedence: non-blank `$DSH_HOME`, else `~/.dsh`). Replicated rather than
 * imported: a `link:`-mounted plugin cannot resolve `@deepseek-ai/*` bare
 * specifiers at all (verified ERR_MODULE_NOT_FOUND).
 *
 * The previous expression fell back to `join(process.env.HOME || ".", ".dsh")`,
 * which on Windows (where `HOME` is unset) produced a *relative* `./.dsh` and
 * silently wrote next to the Host's working directory instead of the Harness
 * home.
 * @param env - environment mapping, injectable for tests.
 * @returns absolute Harness home.
 */
function resolveDshHome(env = process.env) {
	const fromEnv = env.DSH_HOME;
	if (typeof fromEnv === "string" && fromEnv.trim().length > 0) return resolve(expandHome(fromEnv.trim()));
	return join(homedir(), ".dsh");
}
/** Expand a leading `~`, `~/`, or `~\` against the OS home. */
function expandHome(path) {
	if (path === "~") return homedir();
	if (path.startsWith("~/") || path.startsWith("~\\")) return join(homedir(), path.slice(2));
	return path;
}

/**
 * Durable per-teammate route store.
 *
 * Kept outside the session log on purpose: the first `subagent/descriptor`
 * event is authoritative and later same-type events are ignored by
 * `foldSubagentDescriptor`, so a descriptor append would be display-only.
 * This store is applied instead at the `agents.create`/`agents.resume` seam,
 * which every continuation materialization walks through.
 */
function createRouteStore(logger) {
	const file = join(resolveDshHome(), "team-member-routes.json");
	let routes = new Map();
	const readRows = (path) => {
		if (!existsSync(path)) return void 0;
		const parsed = JSON.parse(readFileSync(path, "utf8"));
		return Array.isArray(parsed?.routes) ? parsed.routes : void 0;
	};
	const toMap = (rows) => new Map((rows ?? []).filter((row) => row && typeof row.sessionId === "string" && typeof row.provider === "string" && typeof row.model === "string").map((row) => [row.sessionId, { provider: row.provider, model: row.model, ...(typeof row.reasoningEffort === "string" ? { reasoningEffort: row.reasoningEffort } : {}) }]));
	const load = () => {
		try {
			routes = toMap(readRows(file));
			// One-time migration from the pre-0.3.1 relative `./.dsh` location,
			// which followed the Host working directory instead of the Harness home.
			const legacyPath = resolve(join(".dsh", "team-member-routes.json"));
			if (routes.size === 0 && legacyPath !== resolve(file)) {
				const legacy = toMap(readRows(legacyPath));
				if (legacy.size > 0) {
					routes = legacy;
					save();
					logger?.info?.(`team-member-routes: migrated ${legacy.size} route(s) from ${legacyPath}`);
				}
			}
		} catch (error) {
			logger?.warn?.(`team-member-routes: could not read ${file}: ${errorText(error)}`);
		}
	};
	const save = () => {
		try {
			const body = JSON.stringify({ version: 1, routes: [...routes.entries()].map(([sessionId, route]) => ({ sessionId, ...route })) }, null, 2);
			mkdirSync(dirname(file), { recursive: true });
			writeFileSync(file, body, "utf8");
		} catch (error) {
			logger?.warn?.(`team-member-routes: could not write ${file}: ${errorText(error)}`);
		}
	};
	load();
	return {
		file,
		get: (sessionId) => routes.get(sessionId),
		set: (sessionId, route) => {
			routes.set(sessionId, route);
			save();
		},
		drop: (sessionId) => {
			if (!routes.delete(sessionId)) return;
			save();
		}
	};
}

/**
 * Instance-level shadow of `SubagentRuntime.startContinuable`, injecting the
 * creation-time route that `spawn_teammate_route` registered. Never throws into
 * the official path: any wrapper failure degrades to stock inheritance.
 */
function wrapStartContinuable(subagents, pending, store, logger) {
	if (!subagents || typeof subagents.startContinuable !== "function") {
		logger?.warn?.("team-member-routes: subagents.startContinuable unavailable; per-member routing disabled");
		return;
	}
	if (subagents.__teamRouteWrapped === true) return;
	const original = subagents.startContinuable.bind(subagents);
	let warnedSpecShape = false;
	const wrapped = async (spec) => {
		let injected;
		try {
			const parentId = spec?.request?.parent?.id;
			if (parentId !== undefined && typeof spec.label === "string" && spec.request.agentOptions === undefined) {
				const route = pendingTake(pending, pendingKey(parentId, spec.label));
				if (route !== undefined) {
					injected = route;
					spec = { ...spec, request: { ...spec.request, agentOptions: route } };
				}
			} else if (!warnedSpecShape && spec?.request !== undefined && spec.request.parent === undefined) {
				warnedSpecShape = true;
				logger?.warn?.("team-member-routes: startContinuable spec has no request.parent; routing skipped (upstream signature drift?)");
			}
		} catch {
			/* the wrapper must never break the official spawn path */
		}
		const started = await original(spec);
		// Mirror the creation route into the durable store so a later re-route is
		// the only override in play, and a cleared override falls back to the
		// descriptor instead of to the Lead.
		if (injected !== undefined && started?.childId !== undefined) {
			try {
				store.set(started.childId, injected);
			} catch {
				/* non-critical */
			}
		}
		return started;
	};
	wrapped.__teamRouteWrapped = true;
	try {
		subagents.startContinuable = wrapped;
	} catch (error) {
		logger?.warn?.(`team-member-routes: could not wrap startContinuable: ${errorText(error)}`);
	}
}

/**
 * Shadow `agents.create` / `agents.resume` so a stored route replaces the
 * AgentOptions that materialization would otherwise derive (inherited route for
 * a plain `spawn_teammate`, descriptor route for a cold resume).
 */
function wrapAgentMaterialization(agents, store, logger) {
	for (const method of ["create", "resume"]) {
		const target = agents?.[method];
		if (typeof target !== "function" || target.__teamRouteOverride === true) continue;
		const original = target.bind(agents);
		const wrapped = (options) => {
			try {
				const sessionId = options?.sessionId ?? options?.resumeSessionId;
				const route = typeof sessionId === "string" ? store.get(sessionId) : undefined;
				if (route !== undefined) options = { ...options, agentOptions: { ...options?.agentOptions, ...route } };
			} catch (error) {
				logger?.warn?.(`team-member-routes: ${method} override skipped: ${errorText(error)}`);
			}
			return original(options);
		};
		wrapped.__teamRouteOverride = true;
		try {
			agents[method] = wrapped;
		} catch (error) {
			logger?.warn?.(`team-member-routes: could not wrap agents.${method}: ${errorText(error)}`);
		}
	}
}

/**
 * Apply one route to a live teammate Agent through the official Session-local
 * selection machinery, then keep `agent.options` aligned so `list_agents`, the
 * Team panel, and the descriptor-free request seed all agree.
 */
function applyLiveRoute(sessionController, agent, selected) {
	const inner = sessionController?.agents;
	let durable = false;
	if (inner !== undefined && typeof inner.selectForNextRequest === "function") {
		try {
			inner.selectForNextRequest(agent, selected);
			durable = true;
		} catch {
			/* fall through to the options-only path */
		}
	}
	try {
		const options = agent.options;
		if (options !== undefined && Object.isExtensible(options)) {
			options.provider = selected.provider;
			options.model = selected.model;
			if (selected.reasoningEffort === undefined) delete options.reasoningEffort;
			else options.reasoningEffort = selected.reasoningEffort;
		}
	} catch {
		/* a frozen options object only costs the display alignment */
	}
	return durable;
}

/** Whether one failure is the official subagent-ownership refusal. */
function isSubagentOwnershipRefusal(error) {
	const text = errorText(error);
	return text.includes("owned by subagent routing") || (error?.code === "session/agent-busy" && String(error?.message ?? "").includes("subagent routing"));
}

/**
 * Shadow `sessionController.selectModel` so a Session-local selection change is
 * honoured for a teammate Session instead of refusing with subagent ownership.
 * The official success path is untouched: only the ownership refusal is
 * intercepted, and it is replayed through `applyLiveRoute`.
 */
function patchSelectModel(sessionController, ctx, store, logger) {
	if (!sessionController || typeof sessionController.selectModel !== "function" || sessionController.__teamSelectModelPatched === true) return;
	const original = sessionController.selectModel.bind(sessionController);
	const patched = async (request) => {
		try {
			return await original(request);
		} catch (error) {
			if (!isSubagentOwnershipRefusal(error)) throw error;
			const sessionId = request?.sessionId;
			const agent = typeof sessionId === "string" ? ctx.agents.get(sessionId) : undefined;
			if (agent === void 0) {
				// Inactive teammate: remember the intent; the agents.resume wrapper
				// applies it at the next cold resume.
				const resolved = await ctx.llm.resolveCallConfig({ provider: request.provider, model: request.model, ...(request.reasoningEffort === void 0 ? {} : { reasoningEffort: request.reasoningEffort }) });
				store.set(sessionId, { provider: resolved.provider, model: resolved.model, ...(resolved.reasoningEffort === void 0 ? {} : { reasoningEffort: resolved.reasoningEffort }) });
				return { selected: { provider: resolved.provider, model: resolved.model, ...(resolved.reasoningEffort === void 0 ? {} : { reasoningEffort: resolved.reasoningEffort }) } };
			}
			const selected = await ctx.llm.resolveCallConfig({ provider: request.provider, model: request.model, ...(request.reasoningEffort === void 0 ? {} : { reasoningEffort: request.reasoningEffort }) });
			const route = { provider: selected.provider, model: selected.model, ...(selected.reasoningEffort === void 0 ? {} : { reasoningEffort: selected.reasoningEffort }) };
			store.set(sessionId, route);
			applyLiveRoute(sessionController, agent, route);
			return { selected: { ...route } };
		}
	};
	patched.__teamSelectModelPatched = true;
	try {
		sessionController.selectModel = patched;
	} catch (error) {
		logger?.warn?.(`team-member-routes: could not patch selectModel: ${errorText(error)}`);
	}
}

/**
 * Install the plugin: route store, the three wrappers, and the two tools.
 * @param ctx - host Cordis context.
 * @param config - { freshProvider?, forkProvider? } lifecycle providers, matching
 *   the official tool-agent-team defaults.
 */
export function apply(ctx, config = {}) {
	const resolvedConfig = {
		freshProvider: config.freshProvider ?? "spawn",
		forkProvider: config.forkProvider ?? "fork"
	};
	const pending = new Map();
	const store = createRouteStore(ctx.logger);
	const disposers = [];

	wrapStartContinuable(ctx.subagents, pending, store, ctx.logger);
	wrapAgentMaterialization(ctx.agents, store, ctx.logger);
	// sessionController may mount after this bundle; ctx.inject defers the patch
	// until the service exists instead of silently skipping it (official pattern:
	// dsh-tool-subagent ctx.inject(["session"], ...), graph-memory ctx.inject(["settings"], ...)).
	let sessionController;
	ctx.inject(["sessionController"], (ictx) => {
		sessionController = ictx.sessionController;
		patchSelectModel(sessionController, ctx, store, ctx.logger);
	});

	/** Preflight and commit one route for an existing teammate. */
	async function setTeammateModel(caller, args, signal) {
		const membership = ctx.agentTeams.tryMembership(caller);
		if (membership === undefined) throw new Error("set_teammate_model is only available inside an Agent Teams session");
		if (membership?.role !== "lead") throw new Error("only the Team Lead can change a teammate model");

		const targetName = String(args.target).trim();
		const row = ctx.agentTeams.listMembers(caller).find((member) => member.name === targetName && member.role === "teammate");
		if (row === undefined) throw new Error(`teammate "${targetName}" is not in this Team`);
		// A teammate that is actively working must not be re-routed mid-turn: its
		// in-flight request already carries the old route and a change would split
		// one turn across two models. Stop it first, then re-route.
		if (row.status === "running") throw new Error(`teammate "${targetName}" is running; interrupt it with interrupt_agent before changing its model`);
		if (row.status === "provisioning") throw new Error(`teammate "${targetName}" is still provisioning; its route cannot be changed yet`);

		const requested = {
			provider: args.provider,
			model: args.model,
			...(args.reasoning_effort === undefined ? {} : { reasoningEffort: args.reasoning_effort })
		};
		const resolved = await ctx.llm.resolveCallConfig({ provider: requested.provider, model: requested.model, ...(requested.reasoningEffort === undefined ? {} : { reasoningEffort: requested.reasoningEffort }) }, signal);
		const route = { provider: resolved.provider, model: resolved.model, ...(resolved.reasoningEffort === void 0 ? {} : { reasoningEffort: resolved.reasoningEffort }) };

		// Durable first: a crash before the live apply still leaves the next
		// materialization on the requested model.
		store.set(row.id, route);

		const live = ctx.agents.get(row.id);
		let applied = "durable";
		let note;
		if (live === void 0) {
			note = "teammate is inactive; the route applies at its next wake (cold resume).";
		} else {
			const durableSelection = applyLiveRoute(sessionController, live, route);
			applied = "live";
			note = durableSelection
				? "applied through the Session-local model selection; effective from the teammate's next request."
				: "applied to the live Agent options; the next turn uses it, and the durable store keeps it across restarts.";
		}
		const refreshed = ctx.agentTeams.listMembers(caller).find((member) => member.name === targetName) ?? row;
		return { member: refreshed, route, applied, ...(note === void 0 ? {} : { note }) };
	}

	disposers.push(ctx.tools.register({
		name: "spawn_teammate_route",
		description: "Create one named, durable teammate with its own LLM route (provider/model/reasoning_effort) instead of inheriting the Lead's. Only the Team Lead may call this tool, and only inside an Agent Teams session. The route is preflighted before the roster write, persisted, and survives DSH restarts. context: \"fork\" + a changed route drops KV-prefix reuse with the Lead.",
		parameters: {
			type: "object",
			properties: {
				name: { type: "string", description: "Unique lower-kebab-case teammate name." },
				description: { type: "string", description: "Short description of the delegated responsibility." },
				prompt: { type: "string", description: "Complete initial task for the teammate." },
				context: { type: "string", enum: ["fresh", "fork"], description: "fresh starts without Lead history; fork inherits completed Lead turns. Defaults to fresh." },
				provider: { type: "string", description: "Registered LLM provider id for this teammate. Discover ids with list_subagent_models." },
				model: { type: "string", description: "Model id under `provider` for this teammate." },
				reasoning_effort: { type: "string", description: "Optional reasoning effort, interpreted by the target adapter; omit to let the selected model resolve its own default." }
			},
			required: ["name", "description", "prompt", "provider", "model"],
			additionalProperties: false
		},
		output: { schema: SPAWN_VALUE_SCHEMA, render: jsonRender },
		async execute(args, exec) {
			const agent = exec?.agent;
			if (agent === undefined) throw new Error("spawn_teammate_route requires a calling Agent");
			const membership = ctx.agentTeams.tryMembership(agent);
			if (membership === undefined) throw new Error("spawn_teammate_route is only available inside an Agent Teams session");
			if (membership.role !== "lead") throw new Error("only the Team Lead can create teammates");

			const trimmedName = args.name.trim();
			const context = args.context ?? "fresh";
			const lifecycleProvider = context === "fork" ? resolvedConfig.forkProvider : resolvedConfig.freshProvider;

			const subagentProvider = ctx.subagents.getProvider(lifecycleProvider);
			if (subagentProvider === undefined) throw new Error(`subagent provider "${lifecycleProvider}" is not registered; cannot spawn a routed teammate with context "${context}"`);
			if (subagentProvider.capabilities?.agentOptions !== true) throw new Error(`subagent provider "${lifecycleProvider}" does not support per-child model routing (no agentOptions capability); use the official spawn_teammate instead`);

			const route = {
				provider: args.provider,
				model: args.model,
				...(args.reasoning_effort === undefined ? {} : { reasoningEffort: args.reasoning_effort })
			};
			await ctx.llm.resolveCallConfig({ provider: route.provider, model: route.model, ...(route.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort }) }, exec.signal);

			const key = pendingKey(membership.root.id, args.description);
			pendingEnqueue(pending, key, route);
			try {
				return await ctx.agentTeams.spawnTeammate(agent, {
					name: args.name,
					description: args.description,
					prompt: [{ type: "text", text: identityReminder(trimmedName) }, { type: "text", text: args.prompt }],
					context,
					provider: lifecycleProvider,
					signal: exec.signal
				});
			} finally {
				pendingRemove(pending, key, route);
			}
		}
	}));

	disposers.push(ctx.tools.register({
		name: "set_teammate_model",
		description: "Re-route one EXISTING teammate to a different LLM route (provider/model/reasoning_effort). Only the Team Lead may call this tool, and only inside an Agent Teams session. The route is preflighted before it is committed, stored durably so it survives DSH restarts, and applied immediately to a live teammate (effective from that teammate's next request). A teammate the official UI cannot re-route is still routable here, because teammate Sessions are owned by subagent routing and refuse the composer's model selection. Use list_subagent_models to discover routes; clearing a route is not supported.",
		parameters: {
			type: "object",
			properties: {
				target: { type: "string", description: "Existing teammate name." },
				provider: { type: "string", description: "Registered LLM provider id." },
				model: { type: "string", description: "Model id under `provider`." },
				reasoning_effort: { type: "string", description: "Optional reasoning effort; omit to let the selected model resolve its own default." }
			},
			required: ["target", "provider", "model"],
			additionalProperties: false
		},
		output: { schema: SET_MODEL_VALUE_SCHEMA, render: jsonRender },
		async execute(args, exec) {
			const agent = exec?.agent;
			if (agent === undefined) throw new Error("set_teammate_model requires a calling Agent");
			return await setTeammateModel(agent, args, exec.signal);
		}
	}));

	return () => {
		for (const dispose of disposers.reverse()) {
			try {
				dispose?.();
			} catch {
				/* already disposed with its layer */
			}
		}
		pending.clear();
	};
}
