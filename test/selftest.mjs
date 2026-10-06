/**
 * Offline self-test for dsh-team-member-routes.
 *
 * Runs with plain `node test/selftest.mjs` — no DSH host needed. The plugin is
 * exercised against a mock Cordis context; the client half is evaluated in a
 * `vm` sandbox with a fake `window.__ModuleLoader__`. When a DSH install is
 * reachable, the tool schemas are additionally validated against the official
 * dsh-tools raw-schema validator (skipped silently otherwise).
 */
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import vm from "node:vm";

const here = fileURLToPath(new URL(".", import.meta.url));

// Keep every durable write inside a scratch Harness home.
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), "tmr-selftest-"));

const assert = (cond, msg) => {
	if (!cond) { console.error("FAIL:", msg); process.exit(1); }
	console.log("ok:", msg);
};

// Optional: official schema validator, when a DSH tree is on this machine.
let schemaTools;
try {
	// DSH unpacked location (Windows default install) — best-effort only.
	const candidate = join(process.env.DSH_PROFILE_DIR ?? "", "node_modules", "@deepseek-ai", "dsh-tools", "lib", "index.js");
	const require_ = createRequire(import.meta.url);
	void require_;
	schemaTools = await import(new URL(`file:///${candidate.replace(/\\/g, "/")}`).href);
} catch {
	schemaTools = void 0;
}

const { apply } = await import(new URL("../lib/index.js", import.meta.url).href);

// ---------------------------------------------------------------- host half --
const tools = [];
function makeCtx(members) {
	const lead = { id: "root-1" };
	const live = new Map(members.filter((m) => m.__live).map((m) => [m.id, { id: m.id, options: { provider: "old", model: "old" } }]));
	const ctx = {
		logger: { warn: () => {}, info: () => {} },
		subagents: {
			getProvider: (n) => (n === "spawn" || n === "fork" ? { capabilities: { agentOptions: true } } : undefined),
			startContinuable: async (spec) => { ctx.__lastSpec = spec; return { childId: "child-1", messageId: "m" }; }
		},
		agents: {
			list: () => [lead],
			get: (id) => live.get(id),
			create: async (o) => { ctx.__lastCreate = o; return { agent: { id: o.sessionId }, handle: null }; },
			resume: async (o) => { ctx.__lastResume = o; return { agent: { id: o.resumeSessionId }, handle: null }; }
		},
		agentTeams: {
			tryMembership: (a) => a === lead ? { root: lead, role: "lead" } : a?.__mate ? { root: lead, role: "teammate" } : void 0,
			listMembers: () => members.map((m) => ({ id: m.id, name: m.name, role: "teammate", status: m.status, description: "d", provider: "spawn", context: "fresh", diagnostics: [] })),
			spawnTeammate: async (a, request) => {
				ctx.__spawnRequest = request;
				await ctx.subagents.startContinuable({ childId: "child-1", provider: request.provider, label: request.description, request: { prompt: request.prompt, parent: lead }, signal: request.signal });
				return { member: { id: "child-1", name: request.name, role: "teammate", status: "running", description: request.description, provider: request.provider, context: request.context, diagnostics: [] } };
			}
		},
		tools: { register: (d) => { tools.push(d); return () => {}; } },
		llm: {
			resolveCallConfig: async (c) => {
				if (c.model === "no-such-model") throw new Error(`pi-ai provider "${c.provider}" has no configured model "${c.model}"`);
				return { ...c };
			}
		},
		inject: (keys, fn) => { if (keys.includes("sessionController") && ctx.__sc) fn({ sessionController: ctx.__sc }); },
		get: () => void 0,
		__sc: {
			agents: { selectForNextRequest(agent, sel) { agent.__sel = sel; } },
			// the official refusal for subagent-owned sessions
			selectModel: async (request) => { throw Object.assign(new Error(`session "${request.sessionId}" is owned by subagent routing`), { code: "session/agent-busy" }); }
		}
	};
	return { ctx, lead, live };
}

const signal = new AbortController().signal;
const storeFile = join(process.env.DSH_HOME, "team-member-routes.json");

// --- registration + schema ---------------------------------------------------
{
	const { ctx, lead } = makeCtx([{ id: "m1", name: "mate", status: "running", __live: true }]);
	const dispose = apply(ctx, {});
	const spawn = tools.find((t) => t.name === "spawn_teammate_route");
	const setModel = tools.find((t) => t.name === "set_teammate_model");
	assert(Boolean(spawn) && Boolean(setModel), "registers spawn_teammate_route + set_teammate_model");
	assert(setModel.parameters.required.join(",") === "target,provider,model", "set_teammate_model required args");
	if (schemaTools?.assertSupportedJsonSchema) {
		schemaTools.assertSupportedJsonSchema(spawn.parameters);
		schemaTools.assertSupportedJsonSchema(spawn.output.schema);
		schemaTools.assertSupportedJsonSchema(setModel.parameters);
		schemaTools.assertSupportedJsonSchema(setModel.output.schema);
		assert(true, "schemas pass the official dsh-tools raw-schema validator");
	} else {
		assert(true, "(official validator not reachable on this machine; structural checks only)");
	}

	// auth
	for (const [agent, expected, label] of [
		[{}, /Agent Teams session/, "non-member rejected"],
		[{ __mate: true }, /only the Team Lead/, "teammate caller rejected"]
	]) {
		await setModel.execute({ target: "mate", provider: "p", model: "m" }, { agent, signal }).then(
			() => { console.error("FAIL:", label); process.exit(1); },
			(e) => assert(expected.test(e.message), label)
		);
	}
	void lead;
	dispose?.();
}

// --- running guard (must refuse mid-work) -----------------------------------
{
	tools.length = 0;
	const { ctx, lead } = makeCtx([{ id: "run", name: "busy", status: "running", __live: true }, { id: "prov", name: "prov", status: "provisioning" }, { id: "idle2", name: "idle-pre", status: "idle" }]);
	apply(ctx, {});
	const setModel = tools.find((t) => t.name === "set_teammate_model");
	for (const [name, expected, label] of [
		["busy", /running; interrupt it/, "running teammate REFUSED (interrupt first)"],
		["prov", /provisioning/, "provisioning teammate REFUSED"],
		["ghost", /not in this Team/, "unknown teammate rejected"]
	]) {
		await setModel.execute({ target: name, provider: "p", model: "m" }, { agent: lead, signal }).then(
			() => { console.error("FAIL:", label); process.exit(1); },
			(e) => assert(expected.test(e.message), label)
		);
	}
	// preflight failure leaves no durable trace (target an idle mate so the
	// running guard is not what rejects here)
	await setModel.execute({ target: "idle-pre", provider: "p", model: "no-such-model" }, { agent: lead, signal }).then(
		() => { console.error("FAIL: bad model not rejected"); process.exit(1); },
		(e) => assert(/no-such-model/.test(e.message), "bad model rejected by preflight")
	);
	const stored = existsSync(storeFile) ? JSON.parse(readFileSync(storeFile, "utf8")).routes : [];
	assert(!stored.some((r) => r.sessionId === "run" || r.sessionId === "idle2"), "preflight failure stored nothing");
}

// --- idle live teammate: applied through the official selection path ---------
{
	tools.length = 0;
	const { ctx, lead, live } = makeCtx([{ id: "idle1", name: "idle-mate", status: "idle", __live: true }, { id: "gone1", name: "gone-mate", status: "inactive" }]);
	apply(ctx, {});
	const setModel = tools.find((t) => t.name === "set_teammate_model");
	const r1 = await setModel.execute({ target: "idle-mate", provider: "nvidia", model: "z-ai/glm-5.3-flash", reasoning_effort: "high" }, { agent: lead, signal });
	assert(r1.applied === "live", "idle (not working) teammate re-routed live");
	assert(r1.route.reasoningEffort === "high", "reasoning tier accepted");
	assert(live.get("idle1").__sel.model === "z-ai/glm-5.3-flash", "official selectForNextRequest used");
	assert(live.get("idle1").options.model === "z-ai/glm-5.3-flash" && live.get("idle1").options.provider === "nvidia", "agent.options aligned for display");

	const r2 = await setModel.execute({ target: "gone-mate", provider: "xiaomi", model: "mimo-v2.6-flash" }, { agent: lead, signal });
	assert(r2.applied === "durable" && /next wake/.test(r2.note), "inactive teammate stored durably with note");
	const stored = JSON.parse(readFileSync(storeFile, "utf8")).routes;
	assert(stored.some((r) => r.sessionId === "idle1" && r.provider === "nvidia"), "durable store: idle route persisted");
	assert(stored.some((r) => r.sessionId === "gone1" && r.provider === "xiaomi"), "durable store: inactive route persisted");

	// materialization seam: stored routes win at create/resume
	await ctx.agents.resume({ resumeSessionId: "gone1", agentOptions: { provider: "descriptor" } });
	assert(ctx.__lastResume.agentOptions.provider === "xiaomi", "agents.resume wrapper injected the stored route (cold resume)");
	await ctx.agents.create({ sessionId: "idle1", agentOptions: { provider: "inherited" } });
	assert(ctx.__lastCreate.agentOptions.provider === "nvidia", "agents.create wrapper injected the stored route");

	// the composer's selectModel RPC is served despite the ownership refusal
	const viaPatch = await ctx.__sc.selectModel({ sessionId: "gone1", provider: "buddy", model: "hy4-preview-f" });
	assert(viaPatch.selected.provider === "buddy", "patched sessionController.selectModel serves subagent-owned sessions");
}

// --- spawn regression -------------------------------------------------------
{
	tools.length = 0;
	const { ctx, lead } = makeCtx([]);
	apply(ctx, {});
	const spawn = tools.find((t) => t.name === "spawn_teammate_route");
	const res = await spawn.execute({ name: "reviewer", description: "code review", prompt: "review", provider: "nvidia", model: "z-ai/glm-5.3" }, { agent: lead, signal });
	assert(res.member.name === "reviewer", "spawn returns the official member row");
	assert(ctx.__lastSpec?.request?.agentOptions?.model === "z-ai/glm-5.3", "startContinuable injection still works");
	assert(ctx.__spawnRequest.prompt[0].text === '<system-reminder>\nYou are teammate "reviewer".\n</system-reminder>\n\n', "identity reminder byte-identical to official");
}

// ------------------------------------------------------------- client half ---
{
	const src = readFileSync(join(here, "..", "lib", "client.js"), "utf8");
	assert(/window\.__ModuleLoader__\.load\(/.test(src), "client.js is a __ModuleLoader__ bundle");
	let registered;
	const sandbox = { window: { __ModuleLoader__: { load: (m) => { registered = m; } } }, console, Symbol };
	vm.createContext(sandbox);
	vm.runInContext(src, sandbox, { filename: "client.js" });
	assert(registered?.id === "dsh-team-member-routes", "client factory registers under the package id");
	const exports = registered.factory(() => { throw new Error("this client half requires nothing"); });
	assert(typeof exports.apply === "function" && exports.inject.includes("sessions"), "client exports apply + inject sessions");

	let effects = 0;
	const sessions = {
		subagentAddress(id) {
			if (id === "teammate") return { parentSessionId: "lead", childSessionId: "id", mode: "continuable" };
			if (id === "oneshot") return { parentSessionId: "lead", childSessionId: "id", mode: "one-shot" };
			return void 0;
		}
	};
	const original = sessions.subagentAddress;
	const ctx = { get: (n) => n === "sessions" ? sessions : void 0, effect: (fn) => { effects++; return fn; } };
	const restore = exports.apply(ctx);
	assert(typeof restore === "function", "apply returns a disposer");
	assert(sessions.subagentAddress("teammate") === void 0, "continuable teammate -> gate opens (official picker + effort pane render)");
	assert(sessions.subagentAddress("oneshot")?.mode === "one-shot", "one-shot child untouched");
	assert(sessions.subagentAddress("plain") === void 0 && original("plain") === void 0, "ordinary session untouched");
	exports.apply(ctx);
	assert(sessions.subagentAddress("teammate") === void 0, "double apply is idempotent");
	restore();
	assert(sessions.subagentAddress("teammate")?.mode === "continuable", "disposal restores the official method");
	assert(sessions.__teamPickerWrapped === false, "wrapped flag cleared on disposal");
	assert(effects === 1, "one disposal effect registered per install");
}

rmSync(process.env.DSH_HOME, { recursive: true, force: true });
console.log("\nALL SELF-TESTS PASSED");
