#import <Cocoa/Cocoa.h>
#include "PluginEditor.h"

juce::Rectangle<int> RiffsheetAudioProcessorEditor::getHostVisibleBounds() const
{
    auto* peer = getPeer();
    if (peer == nullptr)
        return getLocalBounds();

    auto* view = static_cast<NSView*> (peer->getNativeHandle());
    if (view == nil || [view window] == nil)
        return getLocalBounds();

    // The JUCE peer may still be 1320px wide while REAPER's FX-chain container
    // exposes only 1210px. Intersect the native ancestors explicitly: with
    // layer-backed JUCE views, visibleRect can extend beyond the host container.
    // Neither JUCE component bounds nor browser innerWidth see this constraint.
    auto visible = [view bounds];
    for (auto* parent = [view superview]; parent != nil; parent = [parent superview])
        visible = NSIntersectionRect (visible, [view convertRect:[parent bounds] fromView:parent]);

    const auto nativeBounds = [view bounds];
    const auto top = [view isFlipped] ? NSMinY (visible) - NSMinY (nativeBounds)
                                    : NSMaxY (nativeBounds) - NSMaxY (visible);
    const juce::Rectangle<float> peerBounds {
        static_cast<float> (NSMinX (visible) - NSMinX (nativeBounds)),
        static_cast<float> (top),
        static_cast<float> (NSWidth (visible)),
        static_cast<float> (NSHeight (visible))
    };

    // Convert through the peer component so host UI scaling is respected too.
    return getLocalArea (&peer->getComponent(), peerBounds).getLargestIntegerWithin();
}
