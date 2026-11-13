// Plugin API — public surface (v3 Phase 4 groundwork, roadmap §4b).
//
// What a caller needs: validate + install a plugin (manifest.ts,
// loader.ts), ask what it may do (capabilities.ts), declare an analysis
// (analysis-spec.ts, parameters.ts), register and run it (registry.ts).
// The example fixture lives under examples/hello-analysis/.

export {
  APP_NAME,
  KNOWN_PERMISSIONS,
  PERMISSION_DESCRIPTIONS,
  PLUGIN_API_MAJOR,
  PLUGIN_API_VERSION,
  describePermissions,
  isValidPluginId,
  manifestReviewLines,
  parseSemver,
  pluginIncompatibility,
  semverAtLeast,
  validatePluginManifest,
  type PluginManifest,
  type PluginPermission,
  type Semver,
} from "./manifest";
export {
  commandsAllowedBy,
  checkCapability,
  requireCapability,
  CapabilityDeniedError,
  COMMAND_DESCRIPTIONS,
  COMMAND_PERMISSIONS,
  KNOWN_COMMANDS,
  type CapabilityCheck,
  type TiterCommand,
} from "./capabilities";
export {
  pluginParamDefaults,
  resolvePluginParamValues,
  validatePluginParameters,
  validatePluginParamValues,
  type PluginParameter,
  type PluginParamValue,
  type PluginParamValues,
} from "./parameters";
export {
  answersToParams,
  jsonSpecToCodeSpec,
  PLUGIN_TABLE_TYPES,
  scanPluginRCode,
  toWizardQuestions,
  validatePluginAnalysisSpec,
  type PluginAnalysisSpec,
  type PluginAnalysisSpecJson,
  type PluginCompute,
  type PluginComputeJson,
  type PluginQuestion,
  type PluginTsCompute,
  type PluginTsComputeInput,
  type PluginTsComputeOutput,
} from "./analysis-spec";
export {
  clearPluginRegistry,
  getPluginAnalysis,
  listPluginAnalyses,
  parsePluginAnalysisId,
  pluginAnalysesForTable,
  pluginAnalysisId,
  registerPluginAnalysis,
  registerPluginAnalysesFromManifest,
  resolveAnalysis,
  runPluginAnalysis,
  unregisterPlugin,
  unregisterPluginAnalysis,
  type PluginAnalysisEntry,
  type PluginAnalysisOutcome,
  type PluginAnalysisResult,
  type ResolvedAnalysis,
} from "./registry";
export {
  confirmEnable,
  disablePlugin,
  installPlugin,
  loadPluginFromFiles,
  loadPluginFromZip,
  parsePluginPackage,
  pluginReviewLines,
  recheckPluginCompatibility,
  requestEnable,
  type ParsedPluginPackage,
  type PluginRecord,
  type PluginStatus,
} from "./loader";
export {
  HELLO_MEAN_ID,
  HELLO_PLUGIN_ID,
  HELLO_SCALED_MEAN_ID,
  helloColumn,
  registerHelloPlugin,
  verifyHelloPlugin,
} from "./examples/hello-analysis/index";
