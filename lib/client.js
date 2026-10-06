/**
 * dsh-team-member-routes — client half.
 *
 * Requirement: the teammate's own dialog (composer) must show the model picker
 * and the reasoning-effort picker. The official `ModelSelect` component already
 * renders BOTH panes; it is hidden only because the composer-side gate treats
 * every addressed subagent session as non-selectable:
 *
 *   dsh-client-ui-model-selection/lib/client.js
 *     L926  /model command     available: (session) => sessions.subagentAddress(session.sessionId) === void 0
 *     L951  composer slot      const available = sessions.subagentAddress(sessionId) === void 0
 *     L493  ModelSelect        if (!available) return null
 *
 * Verified consumers of `sessions.subagentAddress(id)` in the client runtime:
 * model-selection (the picker gate), ui-commands (slash-command list), ui-skill
 * (skill list). Breadcrumb/subagent navigation and the Team panel read the
 * durable address through `session.getSnapshot().subagent.address` /
 * `navigationAddress`, NOT through this method, so patching it does not move
 * navigation or the panel.
 *
 * This half flips the method to `undefined` only for `mode === "continuable"`
 * addresses (a teammate / continuable child). Ordinary sessions and one-shot
 * children are untouched; the picker renders with the official look, the
 * official catalog load, and the official effort pane. The resulting
 * `remote.session.selectModel` call lands on the host half of this plugin,
 * which intercepts the official `session/agent-busy` subagent-ownership refusal
 * and applies the route through `selectForNextRequest` (live) or the durable
 * store (inactive).
 *
 * Known, deliberate breadth: one predicate gates three surfaces, so all three
 * open together inside a teammate composer — the model + effort picker
 * (model-selection L926/L951/L305), the slash-command list (ui-commands L662),
 * and the skill list (ui-skill L345/L354/L371). All three were suppressed for
 * the same reason, and the official `/model` command is one of the newly visible
 * commands, so it works through the same host-side path as the picker.
 * Safety is unchanged: the host still refuses `session.prompt`, queue mutation,
 * and cancel for subagent-owned sessions (`hasApiSessionSubagentOwner`,
 * untouched), so a teammate Session can only be driven through Team routing.
 *
 * Format notes (verified): client entries are plain `window.__ModuleLoader__.load`
 * bundles with a lazy CJS factory. Bare imports are NOT available at ESM level for
 * a link:-mounted package, so every dependency comes through `require` from the
 * browser whitelist: @deepseek-ai/cordis, @deepseek-ai/dsh-client-store,
 * @deepseek-ai/dsh-client-ui-primitives, react, react-dom, react/jsx-runtime.
 * This file needs none of them — it only wraps one service method.
 */
window.__ModuleLoader__.load({
	id: "dsh-team-member-routes",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const inject = ["sessions"];

		/**
		 * Enable the official model + reasoning-effort pickers for teammate dialogs.
		 * @param ctx - client Cordis context.
		 * @returns a disposer restoring the official method, or undefined when the
		 *   service is unavailable (nothing was changed).
		 */
		function apply(ctx) {
			const sessions = ctx.get("sessions");
			if (sessions === void 0 || typeof sessions.subagentAddress !== "function") {
				console.warn("[team-member-routes] sessions.subagentAddress unavailable; teammate picker not enabled");
				return;
			}
			if (sessions.__teamPickerWrapped === true) return;
			const original = sessions.subagentAddress.bind(sessions);
			const patched = (sessionId) => {
				const address = original(sessionId);
				// A teammate composer must expose the model + effort pickers; the
				// official gate hides them for addressed subagent sessions. Flip the
				// judgement for continuable children only.
				if (address !== void 0 && address.mode === "continuable") return void 0;
				return address;
			};
			patched.__teamPicker = true;
			sessions.__teamPickerWrapped = true;
			try {
				sessions.subagentAddress = patched;
			} catch (error) {
				console.warn(`[team-member-routes] could not wrap sessions.subagentAddress: ${String(error)}`);
				sessions.__teamPickerWrapped = false;
				return;
			}
			const restore = () => {
				if (sessions.subagentAddress === patched) {
					sessions.subagentAddress = original;
					sessions.__teamPickerWrapped = false;
				}
			};
			ctx.effect?.(() => restore, "team-member-routes: teammate picker gate");
			return restore;
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
