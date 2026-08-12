#pragma once
#include <JuceHeader.h>
#include <map>
#include <memory>
#include <vector>

/**
    Decoded audio, held natively and handed to JavaScript by reference.

    Sending a few million floats to the WebView as JSON would be absurd, so
    decoded PCM stays here and JS gets a short token. The resource provider
    exposes it at  /native/pcm/<token>.f32  as raw little-endian Float32, which
    the page reads with a single `fetch(...).arrayBuffer()` - one copy, no
    parsing. See BRIDGE.md.

    ------------------------------------------------------------------------
    LIFETIME - read this before adding a caller.

    This store used to be an unbounded `std::map<String, shared_ptr<Entry>>`
    with no eviction anywhere: every recording opened in a session stayed
    resident until the plugin instance died. A ten-minute 44.1 kHz mono take is
    ~106 MB, so five takes was half a gigabyte per instance on an 8 GB machine.

    The fix is NOT a cap. A cap is a guess, it needs tuning, and it can evict a
    take that is still being played or transcribed. Instead:

      **the map holds weak_ptrs, and an entry lives exactly as long as somebody
      is genuinely using it.**

    So `entries` is an index, not an owner. An Entry is destroyed the moment the
    last `shared_ptr<const Entry>` to it goes away, and the map slot is swept up
    on the next lookup or purge.

    Who the owners are, and how each one is guaranteed:

      1. RiffsheetAudioProcessor::loadedEntry   - the playback transport. Held
         for as long as that take is loaded, replaced under playbackLock by
         updateTransportSourceFor(). Since v1.3 the audio thread reads THIS
         buffer directly rather than a second copy of it, so the hold is
         load-bearing, not bookkeeping.
      2. RiffsheetAudioProcessor::handedOutEntry - the most recently handed-out
         take. A token is a string, not a reference, so between the shell
         answering `pickAudioFile()` and the page saying what it wants, nothing
         in C++ would otherwise be holding the audio. This slot closes that
         window and is why a page that never calls pcmRetain() still works.
      3. RiffsheetAudioProcessor::sessionHolds  - what the page declared with
         pcmRetain(). Lives on the PROCESSOR, never the editor: in REAPER the
         editor is destroyed when you click another track, and a hold that died
         with it would resurrect the amnesia bug (design notes §5.5).
      4. NativeBridge::fnTranscribe's worker job - captures a shared_ptr for the
         whole job, so a take being transcribed cannot be released underneath
         the job (nor can its temp WAV be deleted - see ~Entry).
      5. Any local `auto entry = store.get(token)` - get() hands out a strong
         reference, so a caller is safe for as long as its own variable lives.
         getRawFloatBytes() and ensureSourceFile() are both this shape.

    The audio thread is deliberately NOT on that list: it never copies, resets
    or destroys a shared_ptr, because a refcount decrement that happens to be
    the last one would run ~Entry (a free of 100 MB, plus a file delete) on the
    audio thread. It reads a raw pointer published under playbackLock instead.
    See RiffsheetAudioProcessor::updateTransportSourceFor().

    Observability, so this cannot silently regress: getStats() and
    describeEntries(), surfaced on the bridge as `pcmDiagnostics()`.
*/
class PcmStore
{
public:
    struct Entry
    {
        juce::String token;
        juce::File   sourceFile;      // durable for captures/imports after persistTake()

        /** True when `sourceFile` is a temp file WE wrote (a capture rendered by
            ensureSourceFile, or a dropped file staged by importDroppedFile) and
            is therefore ours to delete. Never true for a file the user opened. */
        bool         sourceFileIsTemp = false;

        /** Every temporary source file owned by this entry. Kept separately
            from `sourceFile` so promoting decoded audio from a temp WAV/source
            to durable storage neither leaks the temp nor mistakes the durable
            file for something ~Entry may delete. */
        juce::Array<juce::File> ownedTempFiles;

        /** THE RECORDING THE USER ACTUALLY GAVE US, byte for byte, when we still
            have it - which is NOT the same file as `sourceFile`.

            WHY THE TWO ARE DIFFERENT NOW. `sourceFile` is "a file on disk this
            entry can be re-read from", and `persistTake()` deliberately
            overwrites it with a take of our own making: the picker path calls it
            with forceOwnedCopy, which used to re-encode the DOWNMIXED, RESAMPLED
            analysis buffer as a 24-bit mono WAV and point `sourceFile` at that.
            From that moment nothing native knew where the user's file was, the
            page had no bytes of its own, and saving a document therefore
            embedded a 16-bit mono re-encode of a resampled mono mixdown while
            the format's own documentation promised the imported file "copied
            verbatim". A 24-bit/96 kHz stereo master became 16-bit/44.1 kHz mono
            inside a `.riffsheet`, silently.

            So this field is kept separately and is never pointed at anything
            derived. It is the file the ORIGINAL BYTES are in - the user's own
            file, or an untouched copy of it in the takes folder - and it is what
            /native/source/<token> serves to the page at save time. Empty when
            there is no such file (a track capture never had one). */
        juce::File   originalFile;

        /** True when `originalFile` holds the authoritative recording rather
            than something derived from the analysis buffer.

            False - and this is the honest case, not a failure - when all that
            survives is a re-encode: a capture that has been rendered to WAV, or
            an original too large to keep a copy of. The page shows different
            words and embeds different bytes depending on this, which is the
            whole point: "verbatim" has to be a fact, not a hope. */
        bool         originalIsVerbatim = false;

        juce::String displayName;

        /** IMMUTABLE once the entry has been stored. The audio thread reads
            mono.getReadPointer(0) directly, so nothing may ever resize or
            rewrite this buffer after decodeAndStore()/storeMono() returns. */
        juce::AudioBuffer<float> mono;   // resampled to targetSampleRate

        double sampleRate = 0.0;         // rate of `mono`
        double sourceSampleRate = 0.0;   // rate of the file on disk
        int    sourceChannels = 0;
        double durationSec = 0.0;

        /** What this entry actually costs in RAM. */
        juce::int64 audioBytes() const noexcept
        {
            return (juce::int64) mono.getNumSamples()
                 * (juce::int64) juce::jmax (1, mono.getNumChannels())
                 * (juce::int64) sizeof (float);
        }

        ~Entry();

        JUCE_DECLARE_NON_COPYABLE (Entry)
        Entry() = default;
    };

    /** Totals, for asserting from outside that nothing is piling up. */
    struct Stats
    {
        int liveEntries   = 0;    // entries something is still holding
        int trackedTokens = 0;    // map slots, live plus not-yet-swept
        juce::int64 totalFrames = 0;
        juce::int64 totalBytes  = 0;
    };

    /** One row per live entry, for "which take is holding the memory?". */
    struct EntryInfo
    {
        juce::String token;
        juce::String displayName;
        double sampleRate = 0.0;
        double durationSec = 0.0;
        juce::int64 frames = 0;
        juce::int64 bytes = 0;
        /** How many shared_ptrs hold it, not counting the one this call made.
            Diagnostic only - it is a snapshot of an atomic and can be stale the
            instant it is read. Useful for "who still has this?", never for a
            decision. */
        int holders = 0;
        bool hasSourceFile = false;
        bool sourceFileIsTemp = false;
    };

    PcmStore();

    /** Decodes `file` to mono at `targetSampleRate` and stores it.
        Returns nullptr (and fills `error`) if the file cannot be read.

        `takeOwnershipOfFile` marks the source as a temp file of ours, to be
        deleted when the entry dies - pass true only for something the shell
        itself staged (importDroppedFile), never for a file the user picked.
        `displayName` preserves the user-facing name when a staging path has a
        generated filename. */
    std::shared_ptr<const Entry> decodeAndStore (const juce::File& file,
                                                 double targetSampleRate,
                                                 juce::String& error,
                                                 bool takeOwnershipOfFile = false,
                                                 const juce::String& displayName = {});

    /** Stores already-decoded mono audio (a track capture, say) under a new
        token. `name` is a display name, not a path. */
    std::shared_ptr<const Entry> storeMono (juce::AudioBuffer<float>&& mono,
                                            double sampleRate,
                                            const juce::String& name);

    /** A strong reference, or nullptr if nothing holds this token any more.
        Keep the returned shared_ptr for as long as you need the samples: a
        token on its own guarantees nothing. */
    std::shared_ptr<const Entry> get (const juce::String& token) const;

    /** A real file on disk for this token, writing a temp WAV if the entry has
        no source file (captures) or the original has moved. MuScriptor uploads
        a file, so something has to exist on disk.

        The temp WAV belongs to the entry and is deleted with it, so the CALLER
        must keep a shared_ptr (see get()) for as long as the path is in use. */
    juce::File ensureSourceFile (const juce::String& token, juce::String& error);

    /** Writes decoded audio to <Application Support>/Riffsheet/takes as a
        durable WAV and makes it this entry's source file. Used for captures
        and for browser-provided audio whose only native path was staging data.

        The write goes to a UUID-named partial in the same directory and is
        renamed only after the WAV header has been flushed, so a crash cannot
        leave a half-written file at the path persisted in a DAW project. The
        returned file is NEVER owned or deleted by the Entry. `bitsPerSample`
        is restricted to 16 or 24; durable user audio uses 24.

        `forceOwnedCopy` also copies a readable external source. Picker/import
        paths use this before persisting AudioRef.path, so an untrusted DAW state
        never needs authority to reopen an arbitrary filesystem path. */
    juce::File persistTake (const juce::String& token,
                            juce::String& error,
                            int bitsPerSample = 24,
                            bool forceOwnedCopy = false);

    /** Raw bytes for the /native/pcm/<token>.f32 route, or nullopt. */
    std::optional<std::vector<std::byte>> getRawFloatBytes (const juce::String& token) const;

    /** What the page needs in order to talk about the original recording without
        reading it: whether one survives, how big it is and what it is called.
        Cheap - one stat. */
    struct OriginalInfo
    {
        bool available = false;      // there is a file and it is within the limit
        bool verbatim = false;       // ...and it is the user's own bytes, not a re-encode
        juce::int64 bytes = 0;
        juce::String name;           // with its real extension: "riff.flac", not "riff.wav"
    };

    OriginalInfo getOriginalInfo (const juce::String& token) const;

    /** The original recording's bytes for the /native/source/<token> route.

        READ ON DEMAND, never eagerly. The page asks for these once, when it is
        actually writing a document, and a hundred-megabyte take that nobody
        saves is therefore never read, never base64'd and never resident twice.
        That is also why this is a resource route rather than a bridge function:
        the JSON bridge would have to base64 it, which is the 3.5x amplification
        the document format was redesigned to get rid of.

        nullopt when the token is unknown, the file has gone, or it is larger
        than riffsheet::limits::containerBytes - in which case the page keeps its
        current behaviour (embed the decoded samples) and says so truthfully. */
    std::optional<std::vector<std::byte>> getOriginalFileBytes (const juce::String& token) const;

    /** Live entry count and total bytes. Sweeps dead map slots on the way. */
    Stats getStats() const;

    /** One row per live entry, in token order. Sweeps dead slots too. */
    std::vector<EntryInfo> describeEntries() const;

    /** Drops map slots whose entry has already been destroyed. Called
        automatically whenever anything is stored or observed; exposed so a test
        can ask for a deterministic sweep. Returns how many slots went. */
    int purgeExpired() const;

    juce::AudioFormatManager& getFormatManager() { return formatManager; }

    /** File-chooser wildcard string covering every format we can read. */
    juce::String getReadableWildcards() const;

private:
    /** Both must be called with `lock` held. */
    juce::String makeTokenLocked();
    int purgeExpiredLocked() const;

    mutable juce::CriticalSection lock;

    /** Serialises source-file creation/promotion. Audio samples are immutable,
        but `ensureSourceFile()` and `persistTake()` may run on worker threads
        and must not race while changing the file behind an entry. */
    juce::CriticalSection sourceFileLock;

    // An INDEX, not an owner - see the LIFETIME note above. Mutable because
    // looking something up is also when we find out a slot has died.
    mutable std::map<juce::String, std::weak_ptr<Entry>> entries;

    juce::AudioFormatManager formatManager;
    int nextId = 1;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (PcmStore)
};
