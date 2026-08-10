#include "ServerRegistry.h"
#include "SystemProbe.h"

namespace ServerRegistry
{
namespace
{
    juce::File registryFile()
    {
        return SystemProbe::appSupportDirectory().getChildFile ("servers.json");
    }

    /** Serialises read-modify-write across processes. Held for microseconds, so
        blocking briefly here is fine - unlike the engine lock, which is held for
        the length of a transcription and therefore may never block anybody. */
    juce::InterProcessLock& fileGuard()
    {
        static juce::InterProcessLock guard ("Riffsheet.servers.v1");
        return guard;
    }

    std::vector<Entry> readEntries()
    {
        std::vector<Entry> entries;
        const auto parsed = juce::JSON::parse (registryFile().loadFileAsString());

        if (const auto* array = parsed.getArray())
        {
            for (const auto& item : *array)
            {
                if (auto* obj = item.getDynamicObject())
                {
                    Entry entry;
                    entry.serverPid = (int) obj->getProperty ("serverPid");
                    entry.port      = (int) obj->getProperty ("port");
                    entry.ownerPid  = (int) obj->getProperty ("ownerPid");
                    entry.startedMs = (double) obj->getProperty ("startedMs");
                    entry.model     = obj->getProperty ("model").toString();

                    if (entry.serverPid > 0)
                        entries.push_back (entry);
                }
            }
        }

        return entries;
    }

    void writeEntries (const std::vector<Entry>& entries)
    {
        juce::Array<juce::var> array;

        for (const auto& entry : entries)
        {
            auto* obj = new juce::DynamicObject();
            obj->setProperty ("serverPid", entry.serverPid);
            obj->setProperty ("port", entry.port);
            obj->setProperty ("ownerPid", entry.ownerPid);
            obj->setProperty ("startedMs", entry.startedMs);
            obj->setProperty ("model", entry.model);
            array.add (juce::var (obj));
        }

        registryFile().replaceWithText (juce::JSON::toString (juce::var (array), true));
    }
}

//==============================================================================
void record (int serverPid, int port, const juce::String& model)
{
    if (serverPid <= 0)
        return;

    const juce::InterProcessLock::ScopedLockType sl (fileGuard());

    auto entries = readEntries();

    entries.erase (std::remove_if (entries.begin(), entries.end(),
                                   [serverPid] (const Entry& e) { return e.serverPid == serverPid; }),
                   entries.end());

    Entry entry;
    entry.serverPid = serverPid;
    entry.port = port;
    entry.ownerPid = SystemProbe::currentProcessId();
    entry.startedMs = SystemProbe::nowMs();
    entry.model = model;
    entries.push_back (entry);

    writeEntries (entries);
}

void forget (int serverPid)
{
    if (serverPid <= 0)
        return;

    const juce::InterProcessLock::ScopedLockType sl (fileGuard());

    auto entries = readEntries();
    entries.erase (std::remove_if (entries.begin(), entries.end(),
                                   [serverPid] (const Entry& e) { return e.serverPid == serverPid; }),
                   entries.end());
    writeEntries (entries);
}

std::optional<Entry> findByPid (int serverPid)
{
    if (serverPid <= 0)
        return std::nullopt;

    const juce::InterProcessLock::ScopedLockType sl (fileGuard());

    for (const auto& entry : readEntries())
        if (entry.serverPid == serverPid)
            return entry;

    return std::nullopt;
}

std::optional<Entry> findByPort (int port)
{
    if (port <= 0)
        return std::nullopt;

    const juce::InterProcessLock::ScopedLockType sl (fileGuard());

    for (const auto& entry : readEntries())
        if (entry.port == port)
            return entry;

    return std::nullopt;
}

//==============================================================================
ReapReport reapOrphans (const std::function<bool (int)>& healthProbe)
{
    ReapReport report;

    const juce::InterProcessLock::ScopedLockType sl (fileGuard());

    const auto existing = readEntries();
    const auto us = SystemProbe::currentProcessId();

    std::vector<Entry> keep;

    for (auto entry : existing)
    {
        if (! SystemProbe::isProcessAlive (entry.serverPid))
            continue;                                     // gone; forget it

        const auto commandLine = SystemProbe::processCommandLine (entry.serverPid);

        if (! SystemProbe::looksLikeMuScriptorServer (commandLine))
            continue;                                     // that pid is somebody else's now

        if (entry.ownerPid == us || SystemProbe::isProcessAlive (entry.ownerPid))
        {
            keep.push_back (entry);                       // in use; hands off
            continue;
        }

        // Orphan: we started it, and the Riffsheet that did is gone.
        if (healthProbe != nullptr && healthProbe (entry.port))
        {
            entry.ownerPid = us;
            keep.push_back (entry);

            report.adoptedPid = entry.serverPid;
            report.adoptedPort = entry.port;
            report.adopted.add ("Re-using the transcription server left behind on port "
                                + juce::String (entry.port) + " by a previous Riffsheet.");
            continue;
        }

        const auto killed = SystemProbe::terminateProcess (entry.serverPid);

        report.killed.add (killed
                           ? "Closed a stuck transcription server left over on port "
                             + juce::String (entry.port) + " (it had stopped answering)."
                           : "Found a stuck transcription server on port " + juce::String (entry.port)
                             + " and could not close it - process " + juce::String (entry.serverPid) + ".");

        if (! killed)
            keep.push_back (entry);
    }

    if (keep.size() != existing.size() || report.adoptedPid != 0)
        writeEntries (keep);

    for (const auto& line : report.killed)
        juce::Logger::writeToLog ("Riffsheet/MuScriptor: " + line);

    for (const auto& line : report.adopted)
        juce::Logger::writeToLog ("Riffsheet/MuScriptor: " + line);

    return report;
}

} // namespace ServerRegistry
