#pragma once
#include <JuceHeader.h>

/**
    One compiled-in row per transcription engine: what it is, what it can do,
    what it costs, and what Riffsheet is allowed to do with its bytes.

    THE MANIFEST IS THE ONLY PLACE AN ENGINE IS DESCRIBED. An adapter reads its
    own row; the bridge reads the table; the build reads it too - see
    EngineCatalog.cpp, where a `static_assert` refuses to compile an entry that
    is unpinned, unverified, or would ship bytes it has no right to ship.
    `redistributable` is therefore enforced by the compiler rather than by a
    sentence in a document somebody has to remember to read.

    Everything here is `const char*` and POD so the whole table is a compile-time
    constant with no static initialisation order to reason about.
*/

enum class InstallKind  { bundled, oneClick, guide };
enum class AdapterKind  { inProcessOnnx, httpServerVenv, sidecarVenv, sidecarPipCli };
enum class Concurrency  { inProcess, exclusiveMachineWide };
enum class ArchiveKind  { none, singleFile, zip, pipPackage };

/** The sentinel a real sha256 replaces. EngineCatalog.cpp static_asserts that
    no oneClick entry still carries it, so a half-pinned engine cannot compile,
    let alone ship. */
inline constexpr const char* kSha256Pending = "SHA256-PENDING";

struct EngineDownload
{
    const char* url        = "";   // https only, host must be on kAllowedHosts
    const char* sha256     = kSha256Pending;
    juce::int64 bytes      = 0;    // exact, for the disk check and the progress bar
    ArchiveKind archive    = ArchiveKind::none;
    const char* memberPath = "";   // path inside the zip, "" for singleFile
    const char* pipSpec    = "";   // "transkun==0.0.0", pipPackage only
};

/** One numbered step of a guided setup.

    The pair shape is not decoration: the setup screen draws `what` in a
    <strong> and `detail` in a <div class="dim">, and a flat string list would
    silently lose half of every step. Defined before EngineManifest because the
    table below initialises pointers to it at compile time. */
struct GuideStep
{
    const char* what;
    const char* detail;
};

struct EngineManifest
{
    // identity
    const char* id;             // stable, lowercase-hyphen; the wire value everywhere
    const char* name;           // "Basic Pitch"
    const char* tierLabel;      // "Built in" | "Best quality" | "One-click"
    const char* summary;        // one sentence, shown on the card
    const char* sourceUrl;      // the official project page, shown and linkable

    // shape
    AdapterKind adapter;
    InstallKind install;
    Concurrency concurrency;

    // capability (mirrors EngineAdapter::Capabilities; the adapter may widen
    // `instruments` at runtime, never narrow the flags)
    const char* const* instrumentStrengths;  // for the card: {"Bass","Guitar"}
    int   instrumentStrengthCount;
    bool  acceptsInstrumentConstraint;
    bool  producesBeatGrid;
    bool  producesConfidence;
    bool  producesVelocity;
    bool  needsGainNorm;
    bool  needsTuningNorm;
    double preferredInputRate;   // 0 = source rate

    // licensing - REDISTRIBUTABLE IS LOAD-BEARING, see EngineCatalog.cpp
    const char* codeLicense;
    const char* weightsLicense;
    bool  redistributable;       // may this engine's bytes be in a release?

    // install / runtime layout
    EngineDownload download;
    const char* runtimeSubdir;     // "" for bundled; else <appSupport>/engines/<this>
    const char* argvTemplate;      // sidecar only; see SidecarAdapter.h for the placeholders
    /** Sidecar only. The FILENAME of the script in shell/Resources/engines/,
        which is both what the installer writes into the engine folder and what
        `{script}` expands to. Not the generated BinaryData symbol: JUCE mangles a
        filename into an identifier by deleting hyphens, so the installer looks
        resources up by their original name instead. "" for a console-script
        engine, which needs no script at all. */
    const char* scriptResource;
    const char* pythonRequirement; // "" or e.g. ">=3.9,<3.13"
    juce::int64 approxDiskBytes;
    int   approxPeakRssMb;

    // guide (install == guide, and as the fallback text when a one-click fails)
    const GuideStep* guideSteps;
    int   guideStepCount;
};
