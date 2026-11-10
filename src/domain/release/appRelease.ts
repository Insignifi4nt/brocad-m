import packageInfo from '../../../package.json';

export const APP_VERSION = packageInfo.version;
export const DOCUMENTATION_URL = 'https://brocad-m.visionforge.cc/documentation/';
export const APP_SOURCE_URL = `https://github.com/Insignifi4nt/brocad-m/tree/v${APP_VERSION}`;

/** App provenance is informational. Exact schemas, capabilities and conformance decide execution. */
export const POST_CONTRACT_CHANGES = [
  'App 0.0.689 corrects containment for newly analyzed concave and curved geometry. Contour roles, cut order and automatic compensation can change, so review kept material and exact controller output with the installed setup. Existing installed packages and saved revisions are preserved.',
  'Post schema v2 replaces the wireSeparation boolean with exact mechanism names: manual-before-positioning, automatic-before-positioning, or automatic-during-positioning. Legacy booleans remain readable but do not authorize a mechanism.',
  'Arc commands require an explicit arcDirection. Motion audit checks formatted, quantized coordinates and declared state effects.',
  'UPID v2 represents after-positioning stops and separation during positioning. A legacy saved plan that differs from the current compiler requires a new saved revision.',
  'UPID v3 adds after-contour-distance stops measured along the exit lead and next positioning. The program-stop placement vocabulary expands and travel moves may be split around a pause. Strict posts or posts assuming unsplit moves may reject these jobs; inspect exact controller output and preserve installed packages and saved revisions. Older apps reject v3.'
] as const;
