
/**
 * Text drawing mode.
 * On click a point is placed and a prompt asks the user for the text content.
 * The created point feature stores the text in a `text` property, which is used
 * by the Mapbox symbol layer defined in `Map.tsx`.
 * The default font is Arial, size 14, color white. The user can edit the text
 * later by double‑clicking the point (opens the same prompt).
 */
const DrawText = {
  onSetup(this: any) {
    this._state = { featureId: null };
    return {};
  },

  onClick(state: any, e: any) {
    this.map.fire('draw.text_prompt', { lngLat: e.lngLat });
    this.changeMode('simple_select');
  },

  onStop(state: any) {
    this.activateUIButton();
  },

  toDisplayFeatures(state: any, geojson: any, display: any) {
    display(geojson);
  },
} as any;

export default DrawText;
