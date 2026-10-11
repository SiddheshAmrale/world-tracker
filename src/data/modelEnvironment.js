// Image-based lighting for moving aircraft models.
//
// Every Cesium Model owns a DynamicEnvironmentMapManager that re-renders a sky
// cubemap around the model and reads its irradiance back from the GPU whenever
// the model has moved more than `maximumPositionEpsilon` metres. Cesium's
// default for primitives is 1 km, which an airliner covers in ~4 s, so with a
// fleet of 3D models on screen the readbacks (a pipeline stall each) showed up
// at the top of the live-contacts profile. The sky light does not visibly
// change over a few dozen kilometres; regenerate only after 100 km (several
// minutes of flight). Cesium's own Entity models use an infinite epsilon.
export const MOVING_MODEL_ENVIRONMENT_MAP = Object.freeze({
  maximumPositionEpsilon: 100_000,
});
