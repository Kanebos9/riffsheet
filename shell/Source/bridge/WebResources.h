#pragma once
#include <JuceHeader.h>

class PcmStore;

/**
    Serves the web app to the WebView.

    Everything the page loads comes through here, which is why the page gets a
    real origin (juce://juce.backend/ on macOS, http://juce.backend/ on Windows)
    instead of file://. That matters: modules, fetch(), Web Audio and
    IndexedDB all refuse to work properly from a file:// origin.

    Routes:
      /                      -> /index.html
      /juce/index.js         -> JUCE's WebView frontend library (packed in)
      /native/pcm/<tok>.f32  -> raw Float32 mono PCM for a PcmStore token
      anything else          -> looked up in the webcore bundle

    The bundle is normally the zip embedded in the binary. If the environment
    variable RIFFSHEET_WEBCORE_DIR points at a directory, that wins - which is
    how Team B iterates on the web app without rebuilding the plugin.
*/
class WebResources
{
public:
    explicit WebResources (PcmStore& pcmStore);

    std::optional<juce::WebBrowserComponent::Resource> lookup (const juce::String& url);

    /** Directory being served in dev mode, or an invalid File in packed mode. */
    juce::File getDevDirectory() const { return devDir; }

    static juce::String mimeForPath (const juce::String& path);

private:
    std::optional<juce::WebBrowserComponent::Resource> fromDisk (const juce::String& path);
    std::optional<juce::WebBrowserComponent::Resource> fromZip (const juce::String& path);
    std::optional<juce::WebBrowserComponent::Resource> notFoundPage (const juce::String& path);

    PcmStore& pcm;
    juce::File devDir;
    std::unique_ptr<juce::ZipFile> zip;
    juce::CriticalSection zipLock;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (WebResources)
};
