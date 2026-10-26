/**
 * Codex mode, browser half.
 *
 * Replaces the current-session permission control with the same control plus a
 * Codex switch at the top of its menu. The switch and the permission choices
 * are two dimensions: turning Codex on maps the current permission to its
 * matching `codex-*` identity, and picking another permission while the mode is
 * on moves to that permission's Codex identity. The Host owns the durable state;
 * this module only reads the permission projection and sends `/permission`.
 *
 * @module @local/dsh-codex-mode/client
 */

window.__ModuleLoader__.load({
	id: '@local/dsh-codex-mode',
	factory(require) {
		const React = require('react');
		const ReactDOM = require('react-dom');
		const h = React.createElement;
		const { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } = React;

		/** Dictionary namespace owned by this plugin. */
		const NS = 'codexMode';

		/** Permission identities appended by the bundle patch. */
		const CODEX_PREFIX = 'codex-';

		/** Simplified Chinese dictionary (the key-set source of truth). */
		const zh = {
			'mode': '访问模式，当前：{name}',
			'menu.label': '权限与 Codex 模式',
			'codex.label': 'Codex 模式',
			'codex.badge': 'CX',
			'codex.hint': '按 Codex 的执行循环工作：执行中持续输出进度，先读代码、列计划、逐步实现并验证。开关状态会记住并同步到所有会话，权限级别保持不变。',
			'codex.autoOff': '关闭 Codex 模式后才能使用自动审查',
			'codex.unavailable': '先切换到固定权限后才能开启 Codex 模式',
			'codex.on': 'Codex 模式已开启（所有会话）',
			'codex.off': 'Codex 模式已关闭（所有会话）',
			'preset.readOnly': '仅可查看',
			'preset.workspaceWrite': '工作区内修改',
			'preset.fullAccess': '完全权限',
			'preset.custom': '自定义',
			'preset.unknown': '权限',
			'auto.label': '自动审查',
			'auto.badge': 'EXP',
			'auto.description': '无沙箱运行；每次原生工具调用和 PTC 内层调用前由同一模型进行实验性审查。',
			'confirm.title': '确认启用完全权限？',
			'confirm.description': '启用完全权限后，智能体将减少确认步骤，并且可以直接执行更多操作，包括敏感操作、文件修改或外部命令。仅建议在你信任当前任务时使用。',
			'confirm.acknowledge': '我已了解风险，并愿意继续',
			'confirm.cancel': '取消',
			'confirm.close': '关闭',
			'confirm.enable': '启用完全权限',
			'auto.confirm.title': '确认启用自动审查（实验）？',
			'auto.confirm.description': '自动审查不使用沙箱。每次原生工具调用和 PTC 内层调用前，都会由与当前 agent 相同的模型进行审查；审查拒绝的调用由你批准或拒绝。此功能仍属实验性，可能误放行或误拒绝，并会消耗额外 token。',
			'auto.confirm.acknowledge': '我已了解这些风险，并愿意继续',
			'auto.confirm.enable': '启用自动审查',
			'error.catalog': '无法读取权限选项',
			'error.switch': '切换失败，请重试',
			'error.unavailable': '当前环境不支持切换权限',
		};

		/** English dictionary, checked complete against the zh key set. */
		const en = {
			'mode': 'Access mode, current: {name}',
			'menu.label': 'Permission and Codex mode',
			'codex.label': 'Codex mode',
			'codex.badge': 'CX',
			'codex.hint': "Run Codex's execution loop with live progress while tools run: inspect, plan, implement in verified increments. The switch is remembered across all sessions; the permission level stays unchanged.",
			'codex.autoOff': 'Turn Codex mode off before using Auto review',
			'codex.unavailable': 'Select a fixed permission before enabling Codex mode',
			'codex.on': 'Codex mode is on for every session',
			'codex.off': 'Codex mode is off for every session',
			'preset.readOnly': 'Read Only',
			'preset.workspaceWrite': 'Workspace Write',
			'preset.fullAccess': 'Full access',
			'preset.custom': 'Custom',
			'preset.unknown': 'Permission',
			'auto.label': 'Auto review',
			'auto.badge': 'EXP',
			'auto.description': 'Run without a sandbox after an experimental same-model review of every native tool call and PTC inner call.',
			'confirm.title': 'Enable Full access?',
			'confirm.description': 'Full access reduces confirmation steps and lets the agent perform more actions directly, including sensitive operations, file changes, or external commands. Only use it when you trust the current task.',
			'confirm.acknowledge': 'I understand the risks and want to continue',
			'confirm.cancel': 'Cancel',
			'confirm.close': 'Close',
			'confirm.enable': 'Enable Full access',
			'auto.confirm.title': 'Enable Auto review (experimental)?',
			'auto.confirm.description': 'Auto review runs without a sandbox. Before every native tool call and PTC inner call, the same model as the current agent reviews whether to allow it; you approve or reject each call it denies. This feature is experimental, can falsely allow or deny actions, and uses additional tokens.',
			'auto.confirm.acknowledge': 'I understand these risks and want to continue',
			'auto.confirm.enable': 'Enable Auto review',
			'error.catalog': 'Could not read the permission options',
			'error.switch': 'Could not switch; try again',
			'error.unavailable': 'This environment cannot switch permissions',
		};

		/** Plugin stylesheet, inserted once per Client run and removed with it. */
		const CSS = `
.dcm-trigger{min-width:0;max-width:220px;height:28px;box-sizing:border-box;display:inline-flex;align-items:center;gap:5px;margin:0;padding:0 4px 0 8px;border:none;border-radius:var(--dsw-radius-sm,6px);background:0 0;color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;font-weight:500;line-height:20px;white-space:nowrap;cursor:pointer;outline:none}
.dcm-trigger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgb(0 0 0 / 6%))}
.dcm-trigger:focus-visible{box-shadow:0 0 0 2px var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary))}
.dcm-trigger:disabled{color:var(--dsw-alias-label-dimmed,var(--dsw-alias-label-secondary));cursor:default;opacity:.6}
.dcm-triggerIcon{flex:none;display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px}
.dcm-triggerIcon svg{width:14px;height:14px}
.dcm-triggerLabel{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dcm-triggerDivider{flex:none;width:1px;height:12px;background:var(--dsw-alias-border-l2);margin:0 1px}
.dcm-codexSlot{flex:none;display:inline-flex;align-items:center;justify-content:flex-start;box-sizing:border-box;width:0;margin-left:-5px;overflow:hidden;opacity:0;transform:translateX(-4px);pointer-events:none;transition:width .24s cubic-bezier(.22,1,.36,1),margin-left .24s cubic-bezier(.22,1,.36,1),opacity .12s linear,transform .24s cubic-bezier(.22,1,.36,1)}
.dcm-codexSlot[data-on]{width:22px;margin-left:0;opacity:1;transform:translateX(0)}
.dcm-codexSlot .dcm-triggerDivider{opacity:0;transition:opacity .14s linear .04s}
.dcm-codexSlot[data-on] .dcm-triggerDivider{opacity:1}
.dcm-codexMark{flex:none;display:inline-flex;align-items:center;justify-content:center;width:14px;height:14px;margin-left:5px;color:var(--dsw-alias-brand-primary)}
.dcm-chevron{flex:none;display:inline-flex;color:var(--dsw-alias-label-caption,var(--dsw-alias-label-secondary));transition:transform .12s ease}
.dcm-chevronOpen{transform:rotate(180deg)}
.dcm-menu{position:fixed;z-index:1300;box-sizing:border-box;width:244px;max-width:calc(100vw - 16px);display:flex;flex-direction:column;gap:1px;padding:5px;border:.5px solid var(--dsw-alias-border-l1);border-radius:14px;background:var(--dsw-specific-menu,var(--dsw-alias-bg-overlay));box-shadow:var(--dsw-elevation-prominent,0 8px 28px rgb(15 23 42 / 18%));backdrop-filter:var(--dsw-menu-backdrop-filter,blur(14px));color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:18px}
.dcm-item{box-sizing:border-box;width:100%;min-height:36px;display:flex;align-items:center;gap:9px;margin:0;padding:0 9px;border:none;border-radius:9px;background:0 0;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:18px;text-align:left;cursor:pointer;outline:none}
.dcm-item:hover:not(:disabled),.dcm-item:focus-visible{background:var(--dsw-alias-interactive-bg-hover,rgb(0 0 0 / 6%))}
.dcm-item:disabled{cursor:default;opacity:.48}
.dcm-icon{flex:none;width:16px;height:16px;display:inline-flex;align-items:center;justify-content:center;color:var(--dsw-alias-label-secondary)}
.dcm-icon svg{width:16px;height:16px}
.dcm-label{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dcm-badge{flex:none;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));font-size:8px;font-weight:500;line-height:10px;letter-spacing:.2px}
.dcm-check{flex:none;display:inline-flex;width:15px;height:15px;align-items:center;justify-content:center;color:var(--dsw-alias-brand-primary)}
.dcm-check svg{width:15px;height:15px}
.dcm-switch{position:relative;flex:none;width:28px;height:16px;border-radius:999px;background:var(--dsw-alias-border-l2,rgb(0 0 0 / 18%));transition:background-color .16s ease}
.dcm-switch[data-on]{background:var(--dsw-alias-brand-primary)}
.dcm-switch i{position:absolute;top:2px;left:2px;width:12px;height:12px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgb(0 0 0 / 20%);transition:transform .16s ease}
.dcm-switch[data-on] i{transform:translateX(12px)}
.dcm-sep{height:1px;margin:4px 6px;background:var(--dsw-alias-border-l1);flex:none}
.dcm-error{padding:5px 9px 4px;color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:16px;overflow-wrap:anywhere}
.dcm-codexRow{min-height:40px}
.dcm-modalBackdrop{position:fixed;inset:0;z-index:1400;display:flex;align-items:center;justify-content:center;padding:24px;background:rgb(0 0 0 / 34%)}
.dcm-modal{width:380px;max-width:100%;box-sizing:border-box;padding:20px;border:.5px solid var(--dsw-alias-border-l1);border-radius:16px;background:var(--dsw-alias-bg-layer-1,var(--dsw-alias-bg-overlay));box-shadow:var(--dsw-elevation-prominent,0 16px 48px rgb(0 0 0 / 28%));color:var(--dsw-alias-label-primary);font:inherit}
.dcm-modalTitle{margin:0 0 8px;font-size:16px;font-weight:600;line-height:24px}
.dcm-modalDesc{margin:0 0 14px;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px}
.dcm-ack{display:flex;align-items:flex-start;gap:8px;margin:0 0 18px;color:var(--dsw-alias-label-primary);font-size:13px;line-height:18px;cursor:pointer}
.dcm-ack input{flex:none;width:15px;height:15px;margin:1px 0 0;accent-color:var(--dsw-alias-brand-primary)}
.dcm-actions{display:flex;align-items:center;justify-content:flex-end;gap:8px}
.dcm-btn{box-sizing:border-box;height:32px;margin:0;padding:0 14px;border:none;border-radius:var(--dsw-radius-md,8px);background:var(--dsw-alias-bg-layer-2,var(--dsw-alias-bg-layer-1));color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:18px;cursor:pointer}
.dcm-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgb(0 0 0 / 6%))}
.dcm-btn:focus-visible{outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary));outline-offset:2px}
.dcm-btn:disabled{cursor:default;opacity:.45}
.dcm-btnPrimary{background:var(--dsw-alias-brand-primary);color:#fff}
.dcm-btnPrimary:hover:not(:disabled){background:var(--dsw-alias-brand-primary);filter:brightness(1.06)}
@container (width<=460px){.dcm-trigger:has(.dcm-triggerIcon) .dcm-triggerLabel{display:none}}
@media (prefers-reduced-motion: reduce){.dcm-codexSlot,.dcm-codexSlot .dcm-triggerDivider,.dcm-switch,.dcm-switch i,.dcm-chevron{transition:none}}
`;

		/**
		 * Insert the plugin stylesheet once and return its removal.
		 * @returns cleanup for the inserted style element.
		 */
		function installStyles() {
			const marker = '@local/dsh-codex-mode/styles';
			const existing = document.querySelector(`style[data-plugin-css='${marker}']`);
			if (existing !== null) return () => {};
			const tag = document.createElement('style');
			tag.dataset.plugin = '@local/dsh-codex-mode';
			tag.dataset.pluginCss = marker;
			tag.textContent = CSS;
			document.head.appendChild(tag);
			return () => {
				tag.remove();
			};
		}

		/**
		 * Resolve one Client Remote namespace without depending on the parent
		 * facade carrying it as a property.
		 * @param ctx - Client root context.
		 * @param name - namespace name such as `commands`.
		 * @returns the namespace service, or undefined.
		 */
		function remoteNamespace(ctx, name) {
			try {
				return ctx.get(`remote.${name}`);
			} catch (_error) {
				return undefined;
			}
		}

		/**
		 * Read the process permission catalog.
		 * @param ctx - Client root context.
		 * @returns the catalog value.
		 */
		async function loadCatalog(ctx) {
			const permissionPresets = remoteNamespace(ctx, 'permissionPresets');
			if (permissionPresets === undefined || typeof permissionPresets.catalog !== 'function') {
				throw new Error('permission catalog is unavailable');
			}
			const carried = await permissionPresets.catalog();
			if (carried === null || carried === undefined || carried.ok !== true) {
				throw new Error(carried?.error?.message ?? 'permission catalog request failed');
			}
			return carried.value;
		}

		/**
		 * Switch one session's permission identity through the existing command.
		 * @param ctx - Client root context.
		 * @param sessionId - Session whose permission changes.
		 * @param preset - preset identity such as `codex-workspace-write`.
		 * @returns `{ ok: true }` or a failure with a host message.
		 */
		async function switchPreset(ctx, sessionId, preset) {
			const commands = remoteNamespace(ctx, 'commands');
			if (commands === undefined || typeof commands.execute !== 'function') {
				return { ok: false, message: 'permission commands are unavailable' };
			}
			try {
				const carried = await commands.execute(sessionId, `/permission ${preset}`, []);
				if (carried === null || carried === undefined || carried.ok !== true) {
					return { ok: false, message: carried?.error?.message };
				}
				const result = carried.value?.result;
				if (result !== undefined && result !== null && result.kind === 'error') {
					return { ok: false, message: typeof result.text === 'string' ? result.text : undefined };
				}
				return { ok: true };
			} catch (error) {
				return { ok: false, message: error instanceof Error ? error.message : undefined };
			}
		}

		/**
		 * Toggle the profile-level Codex switch. The Host persists it and applies
		 * it to every root session, including this one.
		 * @param ctx - Client root context.
		 * @param sessionId - Session that initiated the toggle.
		 * @param enabled - desired global state.
		 * @returns `{ ok: true }` or a failure with a host message.
		 */
		async function switchCodex(ctx, sessionId, enabled) {
			const commands = remoteNamespace(ctx, 'commands');
			if (commands === undefined || typeof commands.execute !== 'function') {
				return { ok: false, message: 'permission commands are unavailable' };
			}
			try {
				const carried = await commands.execute(sessionId, `/codex-mode ${enabled ? 'on' : 'off'}`, []);
				if (carried === null || carried === undefined || carried.ok !== true) {
					return { ok: false, message: carried?.error?.message };
				}
				const result = carried.value?.result;
				if (result !== undefined && result !== null && result.kind === 'error') {
					return { ok: false, message: typeof result.text === 'string' ? result.text : undefined };
				}
				return { ok: true };
			} catch (error) {
				return { ok: false, message: error instanceof Error ? error.message : undefined };
			}
		}

		/** Locale-owned label for a preset value, with a host-supplied fallback. */
		function presetLabel(value, name, t) {
			if (value === 'read-only') return t('preset.readOnly');
			if (value === 'workspace-write') return t('preset.workspaceWrite');
			if (value === 'danger-full-access') return t('preset.fullAccess');
			if (value === 'auto') return t('auto.label');
			if (value === 'custom') return t('preset.custom');
			return typeof name === 'string' && name !== '' ? name : t('preset.unknown');
		}

		/** The permission level hidden inside a codex-* identity. */
		function baseOf(value) {
			return typeof value === 'string' && value.startsWith(CODEX_PREFIX) ? value.slice(CODEX_PREFIX.length) : value;
		}

		/** Whether a permission value is one of the Codex identities. */
		function isCodex(value) {
			return typeof value === 'string' && value.startsWith(CODEX_PREFIX);
		}

		/** A 16px outline SVG matching the host's permission glyphs. */
		function PermissionSvg({ children }) {
			return h('svg', {
				viewBox: '0 0 16 16',
				width: '16',
				height: '16',
				fill: 'none',
				xmlns: 'http://www.w3.org/2000/svg',
				'aria-hidden': 'true',
				strokeWidth: 1,
			}, children);
		}

		/** Codex mode glyph: a loop with a terminal prompt. */
		function CodexIcon({ size = 16 }) {
			return h('svg', { viewBox: '0 0 16 16', width: size, height: size, fill: 'none', 'aria-hidden': 'true' },
				h('path', {
					d: 'M12.6 4.3A6 6 0 1 0 13.7 8',
					stroke: 'currentColor',
					strokeWidth: '1.4',
					strokeLinecap: 'round',
				}),
				h('path', {
					d: 'M12.6 1.7v3.1H9.5',
					stroke: 'currentColor',
					strokeWidth: '1.4',
					strokeLinecap: 'round',
					strokeLinejoin: 'round',
				}),
				h('path', {
					d: 'm5.2 5.9 2.2 1.8-2.2 1.8M8.5 9.8h2.6',
					stroke: 'currentColor',
					strokeWidth: '1.25',
					strokeLinecap: 'round',
					strokeLinejoin: 'round',
				}));
		}

		/** Host read-only glyph: shield with a check. */
		function ReadOnlyIcon() {
			return h(PermissionSvg, null,
				h('path', {
					d: 'M5.08545 8.13775L7.18455 10.2368C7.26636 10.3187 7.4003 10.3142 7.47649 10.2271L11.5148 5.61194',
					stroke: 'currentColor',
				}),
				h('path', {
					d: 'M6.59624 2.14853C7.50155 1.80917 8.49914 1.80919 9.40444 2.14859L13.9245 3.84317V7.11961C13.9245 11.6089 10.5565 13.5975 8.00035 14.5779C5.44423 13.5975 2.07544 11.6089 2.07544 7.11961V3.84317L6.59624 2.14853Z',
					stroke: 'currentColor',
					strokeLinejoin: 'round',
				}));
		}

		/** Host workspace-write glyph: shield, text lines, and a pencil. */
		function WorkspaceIcon() {
			return h(PermissionSvg, null,
				h('path', {
					d: 'M6.4209 1.68067C7.43922 1.299 8.56177 1.29898 9.58008 1.68067L14.0996 3.375C14.2946 3.44811 14.4236 3.63455 14.4238 3.84278V6.89063C14.1115 6.71853 13.7761 6.58312 13.4238 6.48926V4.18946L9.22852 2.61621C8.43657 2.31947 7.56341 2.31939 6.77148 2.61621L2.5752 4.18946V7.11914C2.5752 11.1796 5.52369 13.056 8 14.0391C8.27653 13.9293 8.55827 13.8067 8.8418 13.6729C9.07101 13.9468 9.33228 14.1929 9.62012 14.4053C9.12409 14.6579 8.63578 14.8696 8.17871 15.0449C8.0637 15.0889 7.93628 15.0889 7.82129 15.0449C5.22011 14.0472 1.5752 11.9381 1.5752 7.11914V3.84278C1.57541 3.63469 1.70463 3.44821 1.89941 3.375L6.4209 1.68067Z',
					fill: 'currentColor',
				}),
				h('path', {
					d: 'M5.26392 6.60339H10.7361',
					stroke: 'currentColor',
				}),
				h('path', {
					d: 'M5.26392 9.86902H8.32833',
					stroke: 'currentColor',
				}),
				h('path', {
					d: 'M10.0317 13.2229C10.263 13.3929 10.4943 13.563 10.7256 13.733C10.7932 13.6482 10.8608 13.5634 10.9284 13.4786C12.1455 11.9522 13.3626 10.4258 14.5798 8.89935C14.6474 8.81455 14.715 8.72975 14.7826 8.64495C14.4143 8.37419 14.046 8.10344 13.6777 7.83268C13.6169 7.92252 13.5562 8.01236 13.4954 8.10219C12.4016 9.71926 11.3078 11.3363 10.214 12.9534C10.1532 13.0432 10.0924 13.1331 10.0317 13.2229Z',
					fill: 'currentColor',
				}),
				h('path', {
					d: 'M12.6516 12.6696C12.6516 12.925 12.6516 13.1804 12.6516 13.4359C12.6952 13.4378 12.7387 13.4398 12.7823 13.4417C13.5663 13.4768 14.3504 13.5118 15.1345 13.5469C15.178 13.5488 15.2216 13.5508 15.2651 13.5527C15.2651 13.2194 15.2651 12.8861 15.2651 12.5527C15.2216 12.5547 15.178 12.5566 15.1345 12.5586C14.3504 12.5936 13.5663 12.6287 12.7823 12.6637C12.7387 12.6657 12.6952 12.6676 12.6516 12.6696Z',
					fill: 'currentColor',
				}));
		}

		/** Host full-access glyph: shield with an exclamation. */
		function FullAccessIcon() {
			return h(PermissionSvg, null,
				h('path', {
					d: 'M6.59624 2.14853C7.50155 1.80917 8.49914 1.80919 9.40444 2.14859L13.9245 3.84317V7.11961C13.9245 11.6089 10.5565 13.5975 8.00035 14.5779C5.44423 13.5975 2.07544 11.6089 2.07544 7.11961V3.84317L6.59624 2.14853Z',
					stroke: 'currentColor',
					strokeLinejoin: 'round',
				}),
				h('path', {
					d: 'M8 4.39209V9.89209',
					stroke: 'currentColor',
				}),
				h('path', {
					d: 'M8 10.8081V11.8081',
					stroke: 'currentColor',
				}));
		}

		/** Host auto-review glyph: shield with an A. */
		function AutoIcon() {
			return h(PermissionSvg, null,
				h('path', {
					d: 'M6.59624 2.14853C7.50155 1.80917 8.49914 1.80919 9.40444 2.14859L13.9245 3.84317V7.11961C13.9245 11.6089 10.5565 13.5975 8.00035 14.5779C5.44423 13.5975 2.07544 11.6089 2.07544 7.11961V3.84317L6.59624 2.14853Z',
					stroke: 'currentColor',
					strokeLinejoin: 'round',
				}),
				h('path', {
					d: 'M5.75 10.15L8 4.95L10.25 10.15M6.43 8.59H9.57',
					stroke: 'currentColor',
					strokeLinecap: 'round',
					strokeLinejoin: 'round',
				}));
		}

		/** Check mark. */
		function CheckIcon() {
			return h('svg', { viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' },
				h('path', {
					d: 'm3.4 8.3 3 3 6.2-6.4',
					stroke: 'currentColor',
					strokeWidth: '1.6',
					strokeLinecap: 'round',
					strokeLinejoin: 'round',
				}));
		}

		/** Disclosure chevron. */
		function ChevronIcon() {
			return h('svg', { viewBox: '0 0 16 16', width: '14', height: '14', fill: 'none', 'aria-hidden': 'true' },
				h('path', {
					d: 'm5 6 3 3 3-3',
					stroke: 'currentColor',
					strokeWidth: '1.4',
					strokeLinecap: 'round',
					strokeLinejoin: 'round',
				}));
		}

		/** Glyph for one permission level. */
		function PermissionIcon({ value }) {
			const base = baseOf(value);
			if (base === 'read-only') return h(ReadOnlyIcon);
			if (base === 'workspace-write') return h(WorkspaceIcon);
			if (base === 'danger-full-access') return h(FullAccessIcon);
			if (base === 'auto') return h(AutoIcon);
			return h(ReadOnlyIcon);
		}

		/** Read the theme custom properties that apply at one element. */
		function readPortalTheme(source) {
			if (source === null || source === undefined) return {};
			const computed = window.getComputedStyle(source);
			const variables = {};
			for (let index = 0; index < computed.length; index += 1) {
				const name = computed[index];
				if (!name.startsWith('--dsw-')) continue;
				const value = computed.getPropertyValue(name);
				if (value !== '') variables[name] = value;
			}
			return variables;
		}

		/**
		 * The replacement permission control.
		 * @param props - locale seat, owner lock, projection hook, and Host verbs.
		 * @returns the trigger, menu, and risk confirmation, or null when the
		 * permission capability is absent.
		 */
		function PermissionControl({ t, locked, useProjection, ops }) {
			const selection = typeof useProjection === 'function' ? useProjection('permissions') : undefined;
			const [catalog, setCatalog] = useState(null);
			const [lastSelection, setLastSelection] = useState(null);
			const [open, setOpen] = useState(false);
			const [busy, setBusy] = useState(false);
			const [error, setError] = useState(null);
			const [pending, setPending] = useState(null);
			const [acknowledged, setAcknowledged] = useState(false);
			const [position, setPosition] = useState(null);
			const [portalVars, setPortalVars] = useState({});
			const triggerRef = useRef(null);
			const menuRef = useRef(null);
			const loadedRef = useRef(false);

			const currentValue = selection?.currentValue ?? lastSelection?.currentValue;
			const codex = isCodex(currentValue);
			const baseValue = baseOf(currentValue);

			useEffect(() => {
				if (selection !== undefined && selection !== null) setLastSelection(selection);
			}, [selection]);

			const options = Array.isArray(catalog?.options) ? catalog.options : [];
			const permissions = useMemo(
				() => options.filter((option) => option && typeof option.value === 'string' && !isCodex(option.value) && option.value !== 'custom'),
				[options],
			);
			const currentOption = permissions.find((option) => option.value === baseValue);

			const refreshCatalog = useCallback(() => Promise.resolve()
				.then(() => ops.loadCatalog())
				.then((value) => {
					setCatalog(value);
					setError(null);
					return value;
				}, () => {
					setError(t('error.catalog'));
					return null;
				}), [ops, t]);

			useEffect(() => {
				if (loadedRef.current) return undefined;
				loadedRef.current = true;
				let alive = true;
				Promise.resolve()
					.then(() => ops.loadCatalog())
					.then((value) => {
						if (alive) setCatalog(value);
					}, () => {
						if (alive) setError(t('error.catalog'));
					});
				return () => {
					alive = false;
				};
			}, [ops, t]);

			useEffect(() => {
				if (error === null) return;
				const timer = window.setTimeout(() => setError(null), 5000);
				return () => window.clearTimeout(timer);
			}, [error]);

			useEffect(() => {
				if (open) return;
				setPosition(null);
			}, [open]);

			useLayoutEffect(() => {
				if (!open) return undefined;
				const anchor = triggerRef.current;
				const menu = menuRef.current;
				if (anchor === null || menu === null) return undefined;
				const anchorRect = anchor.getBoundingClientRect();
				const menuRect = menu.getBoundingClientRect();
				const margin = 8;
				let left = anchorRect.left;
				if (left + menuRect.width > window.innerWidth - margin) left = window.innerWidth - margin - menuRect.width;
				left = Math.max(margin, left);
				let top = anchorRect.top - menuRect.height - margin;
				if (top < margin) top = Math.min(window.innerHeight - menuRect.height - margin, anchorRect.bottom + margin);
				top = Math.max(margin, top);
				setPosition((previous) => previous !== null && previous.left === left && previous.top === top ? previous : { left, top });
				return undefined;
			}, [open, catalog, error]);

			useEffect(() => {
				if (!open) return undefined;
				const closeOnOutside = (event) => {
					const target = event.target;
					if (triggerRef.current?.contains(target)) return;
					if (menuRef.current?.contains(target)) return;
					setOpen(false);
				};
				const closeOnEscape = (event) => {
					if (event.key !== 'Escape') return;
					setOpen(false);
					triggerRef.current?.focus?.();
				};
				const closeOnViewportChange = () => setOpen(false);
				document.addEventListener('pointerdown', closeOnOutside, true);
				document.addEventListener('keydown', closeOnEscape, true);
				window.addEventListener('resize', closeOnViewportChange);
				window.addEventListener('scroll', closeOnViewportChange, true);
				return () => {
					document.removeEventListener('pointerdown', closeOnOutside, true);
					document.removeEventListener('keydown', closeOnEscape, true);
					window.removeEventListener('resize', closeOnViewportChange);
					window.removeEventListener('scroll', closeOnViewportChange, true);
				};
			}, [open]);

			useEffect(() => {
				if (pending === null) return undefined;
				const closeOnEscape = (event) => {
					if (event.key !== 'Escape' || busy) return;
					setPending(null);
					setAcknowledged(false);
				};
				document.addEventListener('keydown', closeOnEscape, true);
				return () => document.removeEventListener('keydown', closeOnEscape, true);
			}, [pending, busy]);

			const applyPreset = useCallback(async (preset, keepOpen = false) => {
				setBusy(true);
				setError(null);
				try {
					const result = await ops.select(preset);
					if (result !== undefined && result !== null && result.ok === false) {
						setError(typeof result.message === 'string' && result.message !== '' ? result.message : t('error.switch'));
						setOpen(true);
						return;
					}
					if (!keepOpen) setOpen(false);
				} catch (failure) {
					setError(failure instanceof Error && failure.message !== '' ? failure.message : t('error.switch'));
					setOpen(true);
				} finally {
					setBusy(false);
				}
			}, [ops, t]);

			const requestPreset = useCallback((preset, keepOpen = false) => {
				if (typeof preset !== 'string' || preset === '') return;
				const risk = !keepOpen && (preset === 'auto' || preset.endsWith('danger-full-access'));
				if (risk) {
					setOpen(false);
					setPortalVars(readPortalTheme(triggerRef.current));
					setAcknowledged(false);
					setPending(preset);
					return;
				}
				void applyPreset(preset, keepOpen);
			}, [applyPreset]);

			const fixedBase = typeof baseValue === 'string' && baseValue !== '' && baseValue !== 'auto' && baseValue !== 'custom';
			const canToggle = !locked && fixedBase && (codex || permissions.some((option) => option.value === baseValue));

			const applyCodex = useCallback(async (enabled) => {
				setBusy(true);
				setError(null);
				try {
					const result = await ops.setCodex(enabled);
					if (result !== undefined && result !== null && result.ok === false) {
						setError(typeof result.message === 'string' && result.message !== '' ? result.message : t('error.switch'));
						setOpen(true);
						return;
					}
					setOpen(true);
				} catch (failure) {
					setError(failure instanceof Error && failure.message !== '' ? failure.message : t('error.switch'));
					setOpen(true);
				} finally {
					setBusy(false);
				}
			}, [ops, t]);

			const toggleCodex = useCallback(() => {
				if (!canToggle || busy) return;
				if (typeof ops.setCodex !== 'function') {
					// A page opened before the global switch shipped still has the
					// old slot props; keep the switch usable until it is refreshed.
					requestPreset(codex ? baseValue : `${CODEX_PREFIX}${baseValue}`, true);
					return;
				}
				void applyCodex(!codex);
			}, [applyCodex, baseValue, busy, canToggle, codex, ops, requestPreset]);

			const choosePermission = useCallback((value) => {
				if (locked || busy) return;
				if (codex && value === 'auto') return;
				const target = codex && value !== 'auto' ? `${CODEX_PREFIX}${value}` : value;
				requestPreset(target);
			}, [busy, codex, locked, requestPreset]);

			const closeMenu = useCallback(() => {
				setOpen(false);
				triggerRef.current?.focus?.();
			}, []);

			if (selection === undefined && lastSelection === null) return null;
			if (currentValue === undefined) return null;

			const label = presetLabel(baseValue, currentOption?.name ?? baseValue, t);
			const triggerTitle = currentOption?.description ?? (codex ? t('codex.hint') : undefined);

			const topRow = h('button', {
				key: 'codex-row',
				type: 'button',
				role: 'switch',
				'aria-checked': codex,
				'aria-label': t('codex.label'),
				title: canToggle ? t('codex.hint') : t('codex.unavailable'),
				className: 'dcm-item dcm-codexRow',
				disabled: !canToggle,
				onClick: toggleCodex,
			},
			h('span', { className: 'dcm-icon' }, h(CodexIcon, { size: 16 })),
			h('span', { className: 'dcm-label' }, t('codex.label')),
			h('span', { className: 'dcm-switch', 'data-on': codex ? 'true' : undefined, 'aria-hidden': 'true' }, h('i')));

			const menu = open ? ReactDOM.createPortal(
				h('div', {
					ref: menuRef,
					className: 'dcm-menu',
					role: 'menu',
					'aria-label': t('menu.label'),
					'aria-busy': busy ? 'true' : undefined,
					style: {
						...portalVars,
						left: position?.left ?? 0,
						top: position?.top ?? 0,
						visibility: position === null ? 'hidden' : 'visible',
					},
				},
				topRow,
				h('div', { key: 'sep', className: 'dcm-sep', role: 'separator' }),
				error === null ? null : h('div', { key: 'error', className: 'dcm-error', role: 'alert' }, error),
				...permissions.map((option) => {
					const selected = option.value === baseValue;
					const autoBlocked = codex && option.value === 'auto';
					return h('button', {
						key: option.value,
						type: 'button',
						role: 'menuitemradio',
						'aria-checked': selected,
						title: autoBlocked
							? t('codex.autoOff')
							: (option.value === 'auto' ? t('auto.description') : option.description),
						className: 'dcm-item',
						disabled: locked || autoBlocked,
						onClick: () => choosePermission(option.value),
					},
					h('span', { className: 'dcm-icon' }, h(PermissionIcon, { value: option.value })),
					h('span', { className: 'dcm-label' }, presetLabel(option.value, option.name, t)),
					option.value === 'auto' ? h('span', { key: 'badge', className: 'dcm-badge' }, t('auto.badge')) : null,
					selected ? h('span', { key: 'check', className: 'dcm-check' }, h(CheckIcon)) : null);
				}),
				), document.body) : null;

			const autoPending = pending === 'auto';
			const confirmationTitle = autoPending ? t('auto.confirm.title') : t('confirm.title');
			const confirmationDescription = autoPending ? t('auto.confirm.description') : t('confirm.description');
			const confirmationAcknowledge = autoPending ? t('auto.confirm.acknowledge') : t('confirm.acknowledge');
			const confirmationEnable = autoPending ? t('auto.confirm.enable') : t('confirm.enable');

			const modal = pending === null ? null : ReactDOM.createPortal(
				h('div', {
					className: 'dcm-modalBackdrop',
					onMouseDown: (event) => {
						if (event.target === event.currentTarget && !busy) {
							setPending(null);
							setAcknowledged(false);
						}
					},
				},
				h('div', { className: 'dcm-modal', style: portalVars, role: 'dialog', 'aria-modal': 'true', 'aria-label': confirmationTitle },
					h('h2', { className: 'dcm-modalTitle' }, confirmationTitle),
					h('p', { className: 'dcm-modalDesc' }, confirmationDescription),
					h('label', { className: 'dcm-ack' },
						h('input', {
							type: 'checkbox',
							checked: acknowledged,
							disabled: busy,
							autoFocus: true,
							onChange: (event) => setAcknowledged(event.target.checked),
						}),
						h('span', null, confirmationAcknowledge)),
					h('div', { className: 'dcm-actions' },
						h('button', {
							type: 'button',
							className: 'dcm-btn',
							disabled: busy,
							onClick: () => {
								setPending(null);
								setAcknowledged(false);
							},
						}, t('confirm.cancel')),
						h('button', {
							type: 'button',
							className: 'dcm-btn dcm-btnPrimary',
							disabled: busy || !acknowledged,
							onClick: () => {
								const preset = pending;
								setPending(null);
								setAcknowledged(false);
								void applyPreset(preset);
							},
						}, confirmationEnable)))),
				document.body);

			return h(Fragment, null,
				h('button', {
					ref: triggerRef,
					type: 'button',
					className: 'dcm-trigger',
					'aria-label': t('mode', { name: label }),
					'aria-haspopup': 'menu',
					'aria-expanded': open,
					title: triggerTitle,
					disabled: locked,
					onClick: () => {
						if (busy) return;
						if (open) closeMenu();
						else {
							setPortalVars(readPortalTheme(triggerRef.current));
							setOpen(true);
							void refreshCatalog();
						}
					},
				},
				h('span', { className: 'dcm-triggerIcon' }, h(PermissionIcon, { value: baseValue })),
				h('span', { className: 'dcm-triggerLabel' }, label),
				h('span', {
					key: 'codex-mark',
					className: 'dcm-codexSlot',
					'data-on': codex ? 'true' : undefined,
					title: codex ? t('codex.on') : undefined,
					'aria-hidden': 'true',
				},
				h('span', { className: 'dcm-triggerDivider' }),
				h('span', { className: 'dcm-codexMark' }, h(CodexIcon, { size: 13 }))),
				h('span', { className: `dcm-chevron${open ? ' dcm-chevronOpen' : ''}`, 'aria-hidden': 'true' }, h(ChevronIcon))),
				menu,
				modal);
		}

		/** Required Client services. */
		const inject = ['slots', 'locale', 'remote', 'remote.commands', 'remote.permissionPresets'];

		/**
		 * Mount the replacement current-session permission control.
		 * @param ctx - Client root context.
		 */
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'codex-mode: dictionaries');
			ctx.effect(() => installStyles(), 'codex-mode: styles');

			ctx.slots.inject('conversation.input.permission', () => ctx.slots.register({
				name: 'conversation.input.permission',
				priority: -1,
				locale: NS,
				inject: (sessionId) => ({
					ops: {
						loadCatalog: () => loadCatalog(ctx),
						select: (preset) => switchPreset(ctx, sessionId, preset),
						setCodex: (enabled) => switchCodex(ctx, sessionId, enabled),
					},
				}),
			}, PermissionControl));
		}

		return { inject, apply };
	},
});
