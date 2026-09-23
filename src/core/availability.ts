/**
 * Whether a provider can be used at all, right now.
 *
 * Checked before routing (Phase 4) rather than discovered by failing a
 * request. Note the hard-won caveat from DECISIONS.md D9: **available is
 * necessary but not sufficient**. On the development Mac, availability
 * reported `available` while every generation failed — so a provider that
 * reports `available` is saying "nothing known is blocking me", not "the
 * next request will succeed". Transient system failures surface through the
 * error taxonomy (`unknown` with `transient: true`), not here.
 */

/**
 * Why a provider cannot be used.
 *
 * The first three mirror Apple's
 * `SystemLanguageModel.Availability.UnavailableReason` exactly — that enum
 * has precisely three cases (docs/research/sdk-surface.md §1). We rename
 * `appleIntelligenceNotEnabled` to the vendor-neutral `notEnabled` because
 * the taxonomy is shared with cloud and (eventually) Android providers.
 * `unsupportedPlatform` is ours, for the case Apple's enum cannot express:
 * the framework is not there at all (Android, web, or an OS below the
 * iOS 27 / macOS 27 floor — DECISIONS.md D4). Importing the package root on
 * such a platform must never throw; it must report this
 * (docs/plan.md §4).
 *
 * `unsupportedLocale` is deliberately **absent**. Per DECISIONS.md D7,
 * Apple has no locale availability reason: locale problems surface at
 * generation time as `LanguageModelError.unsupportedLanguageOrLocale`, and
 * are predictable up front via `supportsLocale()`. A model that works fine
 * in English is not "unavailable" because the caller asked in Polish — that
 * is a per-request failure, so it lives in the error taxonomy
 * (`LLMError` code `unsupportedLocale`) and in `capabilities().locales`.
 */
export type UnavailableReason =
  /** The hardware cannot run the model (Apple: `deviceNotEligible`). */
  | 'deviceNotEligible'
  /** Capable hardware, but the user has not turned the feature on (Apple: `appleIntelligenceNotEnabled`). */
  | 'notEnabled'
  /** Enabled, but model assets are still downloading or otherwise not ready (Apple: `modelNotReady`). */
  | 'modelNotReady'
  /** No such capability on this platform or OS version — e.g. Android, web, or below the OS floor. */
  | 'unsupportedPlatform';

/**
 * Result of `LLMProvider.availability()`.
 *
 * A discriminated union on `available` rather than an
 * `{ available, reason? }` record, so that reading `reason` without first
 * checking `available` does not compile.
 */
export type Availability =
  | {
      readonly available: true;
    }
  | {
      readonly available: false;
      /** Which coarse reason applies. Routers branch on this. */
      readonly reason: UnavailableReason;
      /**
       * Optional human-readable diagnostic for logs and dev UI — e.g. the
       * `debugDescription` from Apple's `AssetsUnavailable`, or the OS
       * version that fell below the floor. Never parse it; never show it as
       * user-facing copy. It exists because "modelNotReady" alone is not
       * enough to debug a support ticket.
       */
      readonly detail?: string;
    };
