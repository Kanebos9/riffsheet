#pragma once
#include <JuceHeader.h>
#include <vector>
#include "EngineManifest.h"

/**
    The compiled-in table of engines, and the invariants it must satisfy.

    THE INVARIANTS ARE CHECKED BY THE COMPILER. `entryIsSane()` below is
    constexpr and EngineCatalog.cpp static_asserts it over the whole table, so
    an engine that is unpinned (still carrying kSha256Pending), unverified, or
    that would ship bytes it has no right to ship, does not build. It is exposed
    here rather than hidden in the .cpp for one reason: the unit tests run the
    same predicate over synthetic rows, so the rule that guards the shipping
    table is the rule that is tested, not a copy of it.

    Everything here is a pure read of constant data - safe on any thread.
*/
namespace EngineCatalog
{
    //== the table =============================================================

    /** All compiled-in rows, in display order. */
    const EngineManifest* begin() noexcept;
    const EngineManifest* end() noexcept;
    int size() noexcept;

    /** The row with this id, or nullptr. */
    const EngineManifest* find (const juce::String& id) noexcept;

    /** An engine whose bytes Riffsheet may not fetch is not offered at all: a
        card with an Install button that must refuse is worse than no card.
        See §2.2 rule 3 - `some` is exactly this case until its weights licence
        has been read by a human. */
    bool isOffered (const EngineManifest& engine) noexcept;

    /** The rows `listEngines()` answers with: everything except
        oneClick && !redistributable. */
    std::vector<const EngineManifest*> offered();

    //== the resolution constants ==============================================

    /** What `auto` prefers when it is installed. */
    const char* autoPreferredId() noexcept;

    /** What `auto` falls back to: the bundled engine, which needs no setup and
        is always present once wave 3 has compiled it in. */
    const char* fallbackId() noexcept;

    //== wire spellings ========================================================
    // The bridge speaks 'bundled' | 'one-click' | 'guide'; the enum spells the
    // middle one differently. One conversion, in one place.

    juce::String installName (InstallKind kind);

    //== the invariants ========================================================

    /** Every rule of §2.3(a) for ONE row. constexpr, so it is the same code the
        static_assert runs and the same code the tests run. */
    constexpr bool entryIsSane (const EngineManifest& e)
    {
        const auto isEmptyString = [] (const char* s) { return s == nullptr || s[0] == '\0'; };

        const auto isHex64 = [] (const char* s)
        {
            if (s == nullptr)
                return false;

            int n = 0;

            for (; s[n] != '\0'; ++n)
            {
                const auto c = s[n];
                const bool hex = (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f');

                if (! hex)
                    return false;
            }

            return n == 64;
        };

        const auto startsWithHttps = [] (const char* s)
        {
            if (s == nullptr)
                return false;

            const char* p = "https://";

            for (int i = 0; p[i] != '\0'; ++i)
                if (s[i] != p[i])
                    return false;

            return true;
        };

        // Identity is not optional: the id is the wire value everywhere.
        if (isEmptyString (e.id) || isEmptyString (e.name))
            return false;

        // Lowercase, digits and hyphens only, and never starting or ending on one.
        {
            int n = 0;

            for (; e.id[n] != '\0'; ++n)
            {
                const auto c = e.id[n];
                const bool ok = (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-';

                if (! ok)
                    return false;
            }

            if (e.id[0] == '-' || e.id[n - 1] == '-')
                return false;
        }

        // A bundled engine's bytes are in the release. It must be redistributable.
        if (e.install == InstallKind::bundled && ! e.redistributable)
            return false;

        // A guided engine must have no download at all - this is the AGPL red line.
        if (e.install == InstallKind::guide
            && (! isEmptyString (e.download.url) || ! isEmptyString (e.download.pipSpec)))
            return false;

        // A one-click engine must be redistributable, pinned and verified.
        if (e.install == InstallKind::oneClick)
        {
            if (! e.redistributable)
                return false;

            if (e.download.archive == ArchiveKind::pipPackage)
            {
                if (isEmptyString (e.download.pipSpec))
                    return false;
            }
            else
            {
                if (! startsWithHttps (e.download.url))
                    return false;

                if (! isHex64 (e.download.sha256))   // kills SHA256-PENDING
                    return false;

                if (e.download.bytes <= 0)
                    return false;
            }
        }

        // A guided engine with no steps is a dead end with no way out of it.
        if (e.install == InstallKind::guide && (e.guideSteps == nullptr || e.guideStepCount <= 0))
            return false;

        return true;
    }
}
