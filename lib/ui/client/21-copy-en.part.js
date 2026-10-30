		const en = {
			nav: "AI adaptation",
			title: "Help the AI adapt to you",
			intro:
				"Pick how the AI should learn to work with you. The two modes are mutually exclusive — exactly one is in effect at any time.",

			modeLegend: "Effective mode",
			modeAuto: "Automatic profile",
			modeAutoDesc: "Summarized by the AI from your past sessions. Read-only.",
			modeCustom: "Custom",
			modeCustomDesc: "You write the system prompt yourself.",
			effectiveNow: "In effect: {name}",
			effectiveAuto: "Automatic profile",
			effectiveCustom: "Custom",
			switchWarnTitle: "Switching to “Automatic profile” makes mode 1 authoritative",
			switchWarnBody:
				"Your mode 2 text is kept — nothing is lost — but it will no longer be injected. Switch anyway?",
			switchWarnConfirm: "Switch anyway",
			switchWarnCancel: "Cancel",
			inactiveTag: "Not in effect",
			activeTag: "In effect",

			autoHeading: "Mode 1 · Automatic profile",
			autoUpdated: "Last updated: {time}",
			autoNever: "No profile has been generated yet",
			autoSaturated: "The profile has reached its growth limit ({n} entries)",
			autoSaturatedBody:
				"New entries will be rejected. Delete, seal, or merge some entries before automatic generation can try again.",
			autoSaturatedStreak:
				"Automatic generation is paused after {n} consecutive runs with no changes.",
			autoBasedOn: "Profile is based on {n} messages",
			autoEvidence: "Based on {n} messages",
			autoQuotes: "{n} quotes",
			autoConfidence: "confidence {level}",
			autoVersion: "v{v}",
			autoExtraLabel: "Supplementary note (appended, read-only)",
			autoEmpty: "No profile yet. It generates on its own once enough messages exist, or press “Regenerate”.",
			autoEmptyHint:
				"No profile text yet. Either the first generation has not finished, or the last one failed — the “Last run” card has the reason. " +
				"The profile appears here automatically once generation succeeds; you can also switch to mode 2 and write your own.",
			copyEmpty: "Nothing to copy: mode 1 has no profile text yet — see the “Last run” card for the reason.",
			autoNotes: "Generator notes",
			autoRaw: "Raw model output (troubleshooting)",

			// —— First-run guidance and auto-update explanation ——
			autoFirstRunTitle: "First run: no profile yet",
			autoFirstRunScanning: "Reading local session logs (read-only)… progress will appear here when the first scan finishes.",
			autoFirstRunModeCustom: "Mode 2 (custom) is active, so no profile is generated automatically. Switch back to mode 1 to enable it.",
			autoFirstRunAutoOff: "Automatic generation is off (profile.autoRun=false): press “Regenerate” to generate one now.",
			autoFirstRunNeed: "The first profile needs {m} human messages in total ({n} collected, {d} to go).",
			autoFirstRunEnough: "Enough material is available; the profile will generate on the next scan — or press “Regenerate” now.",
			autoFirstRunAfter: "Once generated, the profile appears here and every entry can be pinned, sealed, or deleted.",
			autoTriggerLine: "Auto-update: after {m} new messages or {s} new sessions ({n} messages / {k} sessions so far).",
			autoTriggerOff: "Auto-update is off (profile.autoRun=false); “Regenerate” still works.",
			autoTriggerCustom: "Mode 2 is active, so no profile is generated automatically.",

			// —— Per-entry actions: pin / seal / delete ——
			// The semantics live on the host (`lib/index.js` markEntry/clearMark).
			// ⚠️ Keys must mirror the `zh` dictionary one-for-one
			// (test/client-marks-render.mjs asserts the two key sets are identical).
			pinEntry: "Pin",
			pinEntryHint: "Pinning keeps it at the top here and always injects it (budget-exempt). At most {max}.",
			pinEntryLimit: "Pin limit reached ({max}): unpin one first.",
			unpinEntry: "Unpin",
			sealEntry: "Seal",
			sealEntryHint:
				"Sealing moves it to the trash: never injected again, and later updates must not produce it either.",
			unsealEntry: "Restore",
			deleteEntry: "Delete",
			deleteEntryHint:
				"Deleting only removes it from this version; a later summary may bring it back if the evidence is still there (that counts as one deletion).",
			pinnedHeading: "Pinned ({n})",
			pinnedHint:
				"Entries you marked as important: listed first here and always injected (budget-exempt).",
			pinnedGone: "No longer in the profile (the model found no evidence for it)",
			deleteCountBefore: "deleted {n}× before",
			omittedHeading: "Not injected ({n})",
			omittedHint:
				"Entries in the complete profile that the injection budget trimmed out of the system prompt. Category-D entries with weak evidence live in their own “weak evidence” fold above.",
			sealedHeading: "Trash ({n})",
			sealedHint:
				"Entries you sealed: never injected, and later updates must not produce them. Restore if you sealed one by mistake.",
			deletedHeading: "Deleted ({n})",
			deletedHint:
				"Entries you deleted. Deleting does not forbid the model from concluding them again, so they may come back — use “Seal” to block them for good.",
			deletedCount: "deleted {n}×",
			deletedBack: "Back in the profile",
			entryPinnedTag: "Pinned",
			entrySealedTag: "Sealed",

			// —— The text that is actually injected into the system prompt ——
			// Rendered verbatim from the host's `GET /state` field `injectedText`;
			// the UI never reassembles it, so "what you see" is "what is injected".
			injectHeading: "System prompt actually injected",
			injectHint:
				"The block above is the system prompt actually injected (trimmed to budget, {m} entries); below is the complete profile ({n} entries).",
			injectCount: "{m} entries",
			// Per-category counts, taken **verbatim from the host's
			// `injection.injectedByCategory`** — the UI must not compute them
			// (computing here would reintroduce "what you see ≠ what is injected").
			injectBreakdown: "A {a} · B {b} · C {c}",
			injectEmpty: "Nothing is injected right now (no profile text yet).",
			ledgerHint:
				"Injection ledger v{v}: {n} entries have never entered the system prompt (counted by id across versions).",
			ledgerSeen: "Injected in {n} version(s)",
			ledgerNever: "Never injected",
			genWarnings: "Generation warnings ({n})",
			workingNotesHeading: "Working notes ({n})",
			workingNotesHint:
				"Project / tool / path / account / repository facts. They do not use profile slots and are never injected automatically.",
			fullProfileLabel:
				"Complete profile (injection trims to budget; this list is always complete — {n} entries)",
			copy: "Copy",
			copied: "Copied",
			copyFailed: "Copy failed — please select and copy manually",
			regenerate: "Regenerate",
			regenerating: "Generating…",
			regeneratingHint:
				"Generation started in the background; this view updates on its own when it finishes (seconds to minutes).",
			regenerateHint: "Trigger one profile update by hand.",
			confidenceHigh: "high",
			confidenceMedium: "medium",
			confidenceLow: "low",

			revHeadingDirty: "{n} revision(s)",
			revHeadingClean: "Matches what you last copied",
			revHeadingUnknown: "No comparison baseline yet",
			revHeadingStale: "Baseline uses an old format — not compared",
			revHintUnknown: "Copy the mode 1 profile once and this will start reporting real changes.",
			revHintStale: "The entry id format changed. Copy once more to rebuild the baseline.",
			revHintClean: "Nothing in the profile has changed since your last copy.",
			revHintDirty:
				"Compared by entry id: each addition, removal and rewrite counts once.",
			revDetail: "Show the {n}",
			revKindAdded: "added",
			revKindRemoved: "removed",
			revKindModified: "rewritten",
			revBaselineAt: "Baseline: {time}",
			revBaselineVersion: "Baseline profile version: v{v}",
			revSpurious: "Wording-churn rate of the last run: {rate}",

			customHeading: "Mode 2 · Custom",
			customPlaceholder:
				"Write the system prompt you want the AI to follow.\n\nYou can copy the mode 1 profile first, paste it here, and edit.",
			customSave: "Save",
			customSaved: "Saved",
			customSaving: "Saving…",
			customDirty: "Unsaved changes",
			customClean: "In sync with the host",
			customFill: "Fill from mode 1",
			customFillEmpty: "Mode 1 has no profile text to fill in yet.",
			customFillConfirmTitle: "Filling will overwrite the text box",
			customFillConfirmBody: "Nothing has been replaced yet — confirm to continue.",
			customFillConfirm: "Confirm fill",
			customFillCancel: "Cancel",
			customChars: "{n} chars",


			privacyHeading: "Private session permissions",
			privacyDesc:
				"Your profile and custom text are injected only into your own sessions. QQ sessions and subagents get neither, and are not used for learning. Below are the default tool permissions for QQ sessions.",
			privacyQqGroup: "QQ groups",
			privacyQqPrivate: "QQ private chats",
			privacyTierChat: "Chat only",
			privacyTierSafe: "Restricted (own workspace only)",
			privacyTierFull: "Full (no extra limits)",
			privacyFullWarnTitle: "Give QQ sessions full permissions?",
			privacyFullWarnBody:
				"Anyone who can message the bot could make it run commands and read or write any file on this computer. Only do this if the QQ plugin's scope contains nobody but you.",
			privacyFullConfirm: "Confirm",
			privacyFullCancel: "Cancel",
			privacyNotEnforcing: "Tool gating is turned off in the plugin config (privacy.enforceTools): calls are logged, not blocked.",
			privacyMore: "Per-session and per-QQ-chat settings, plus the audit log, are in the local console.",
			privacySaved: "Permissions saved.",
			consoleOpen: "Open console ↗",
			consoleOpening: "Opening…",
			consoleFallback: "If nothing opened, use this one-time sign-in link (valid for 60 seconds):",
			consoleOff: "The local console is not running (console.enabled is off in the plugin config, or the port is taken; see plugin.log).",
			consoleAt: "Console: {url} (accepts connections from this computer only)",

			statusLoading: "Reading host state…",
			statusDisconnected: "Host not connected",
			statusDisconnectedBody:
				"GET {url} failed: {error}. The UI is viewable but reads and writes are unavailable. Check that dsh-whale-shall-adapt is installed in the profile you are using, then reload the page or restart DSH.",
			statusRetry: "Retry",
			statusPreview: "Preview data (UI demo only, host not connected)",
			statusPreviewOn: "Load preview data",
			statusPreviewOff: "Exit preview",
			statusContract: "contract v{v}",
			signalHeading: "The four counter signals",
			signalHint: "These numbers are counted from session logs by the host — not model judgement.",
			signalSessions: "Sessions",
			signalHuman: "Human messages",
			signalDelegate: "AI handed work back",
			signalLongTool: "Runaway commands (over threshold)",
			signalRepeatFail: "Same tool failing repeatedly",
			signalFreeform: "Options offered, you said something else",
			signalUnpaired: "({n} tool results had no matching call and are excluded)",
			lastRunHeading: "Last run",
			lastRunOk: "succeeded",
			lastRunFail: "failed",
			lastRunNone: "not triggered",
			lastRunNoneHint: "The auto-update threshold has not been reached — this is normal, not an error.",
			lastRunReason: "Reason: {reason}",
			errorPrefix: "Error: ",
			unsetCategory: "Other",
			close: "Close",
			openSettings: "Open settings",
		};

