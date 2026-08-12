#pragma once
#include <JuceHeader.h>

/**
    ONE PLACE FOR THE IMPORT/EXPORT SIZE LIMITS, AND ITS OTHER HALF IS IN
    JAVASCRIPT.

    THE BUG THIS FIXES. The same journey - a file the user opens, or a
    `.riffsheet` document going in or out - was bounded in four places with four
    different numbers, none of which knew about the others:

      - the native picker refused any byte-input file over 64 MB;
      - the base64 hand-off from the page allowed 550 MB of characters, which is
        about 412 MB of decoded payload;
      - the document WRITER in webcore permitted a 512 MB audio entry;
      - the document READER in webcore rejected the whole container over 512 MB,
        so the writer could produce a file it would not itself reopen.

    A user with a 200 MB take therefore met a different limit depending on which
    door they came through, and a `.riffsheet` written by one path could be
    unopenable by another. Worse, the reader's per-entry check meant a small
    archive of many highly-compressed entries could ask the DAW's process for
    gigabytes.

    THE NUMBERS ARE PAIRED, and the pairing is the point. Every constant here has
    a counterpart in `webcore/src/bridge/types.ts` (`RIFFSHEET_LIMITS`), which is
    the single JS definition the app, the document reader and the document writer
    all import. If you change a number here, change it there in the same commit -
    the two halves guard the two ends of one pipe, and a limit that only one end
    believes in is not a limit.

        containerBytes    <-> RIFFSHEET_LIMITS.containerBytes
        decodedAudioBytes <-> RIFFSHEET_LIMITS.decodedAudioBytes
        base64PayloadBytes<-> RIFFSHEET_LIMITS.base64PayloadBytes

    WHY 128 MB. It is a working ceiling rather than a moral position: an 8 GB
    machine running a DAW, a WebView and a transcription engine cannot afford a
    half-gigabyte document, and 128 MB is roughly twelve minutes of 24-bit
    stereo 48 kHz WAV - longer than any riff this application is for. The
    decoded-audio ceiling is deliberately the SAME number rather than a derived
    one: two ceilings that differ are how the writer/reader contradiction above
    happened in the first place.
*/
namespace riffsheet::limits
{
    /** The biggest file this application will read into memory: an opened
        `.riffsheet`, a MusicXML/MIDI/GP import, a dropped audio file, a document
        it writes. */
    inline constexpr juce::int64 containerBytes = 128ll * 1024 * 1024;

    /** The biggest single decoded audio payload - the recording inside a
        document, or a staged drop on its way to the decoder. Same number as
        `containerBytes` on purpose: a container that could hold audio it may not
        then decode would be a limit that lies. */
    inline constexpr juce::int64 decodedAudioBytes = 128ll * 1024 * 1024;

    /** The base64 hand-off ceiling, in CHARACTERS, derived from the payload it
        has to carry. Base64 spends 4 characters per 3 bytes; the slack covers
        padding and any line breaks a producer inserts. Checked before a single
        byte is allocated, so an oversized payload costs a comparison rather than
        a 170 MB decode buffer. */
    inline constexpr juce::int64 base64PayloadBytes = (containerBytes + 2) / 3 * 4 + 1024;

    /** "128 MB", for putting in a message to a human. */
    inline juce::String describe (juce::int64 bytes)
    {
        return juce::File::descriptionOfSizeInBytes (bytes);
    }
}
