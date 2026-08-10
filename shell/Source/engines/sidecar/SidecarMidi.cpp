#include "SidecarMidi.h"
#include <algorithm>

namespace SidecarMidi
{
    Result read (juce::InputStream& stream)
    {
        Result result;

        juce::MidiFile file;

        if (! file.readFrom (stream, true))
        {
            result.error = "this is not a MIDI file Riffsheet can read";
            return result;
        }

        // Timestamps arrive in ticks. This walks the tempo events of every track
        // and rewrites every timestamp in seconds - which is why it happens
        // before anything below looks at a time.
        file.convertTimestampTicksToSeconds();

        for (int trackIndex = 0; trackIndex < file.getNumTracks(); ++trackIndex)
        {
            const auto* track = file.getTrack (trackIndex);

            if (track == nullptr)
                continue;

            juce::MidiMessageSequence pairs (*track);
            pairs.updateMatchedPairs();

            juce::String trackName;

            for (int i = 0; i < pairs.getNumEvents(); ++i)
                if (const auto& message = pairs.getEventPointer (i)->message; message.isTrackNameEvent())
                {
                    trackName = message.getTextFromTextMetaEvent().trim();
                    break;
                }

            for (int i = 0; i < pairs.getNumEvents(); ++i)
            {
                const auto* event = pairs.getEventPointer (i);
                const auto& message = event->message;

                if (! message.isNoteOn())
                    continue;

                if (event->noteOffObject == nullptr)
                {
                    ++result.droppedUnterminated;
                    continue;
                }

                const auto start = message.getTimeStamp();
                const auto end = event->noteOffObject->message.getTimeStamp();

                if (! (end > start))
                {
                    ++result.droppedUnterminated;
                    continue;
                }

                Note note;
                note.start = start;
                note.end = end;
                note.pitch = message.getNoteNumber();
                note.velocity = message.getVelocity();
                note.instrument = trackName;
                result.notes.push_back (note);
            }
        }

        std::stable_sort (result.notes.begin(), result.notes.end(),
                          [] (const Note& a, const Note& b)
                          {
                              // Two comparisons rather than an equality test: these
                              // are float seconds and `==` on them is a warning here
                              // and a bug elsewhere.
                              if (a.start < b.start) return true;
                              if (b.start < a.start) return false;

                              return a.pitch < b.pitch;
                          });

        return result;
    }

    Result read (const juce::File& midiFile)
    {
        Result result;

        juce::FileInputStream stream (midiFile);

        if (! stream.openedOk())
        {
            result.error = "could not open " + midiFile.getFullPathName();
            return result;
        }

        return read (static_cast<juce::InputStream&> (stream));
    }
}
