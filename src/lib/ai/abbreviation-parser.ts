/**
 * RadMind AI — Abbreviation Parser (Layer 0)
 * ============================================
 * Built from your actual Word abbreviation list.
 * Runs BEFORE any AI call. Converts your shorthand into
 * full consultant-phrased findings, then sends structured
 * text to the AI (impression + polishing only).
 *
 * Flow:
 *   Radiologist types shorthand
 *       ↓ parseAbbreviations()
 *   ExpandedFinding[]
 *       ↓ toPromptString()
 *   Clean structured text → AI
 *       ↓ AI writes OPINION only
 *   Final report
 */

// ─────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────

export interface ExpandedFinding {
  raw:        string;          // what radiologist typed
  expanded:   string;          // full phrase from your templates
  type:       FindingCategory;
  isUnknown?: boolean;
  isOpinion?: boolean;         // true = O-prefix opinion code → OPINION POINTS section
}

export type FindingCategory =
  | "spondylosis"
  | "disc_cervical"
  | "disc_lumbar"
  | "spondylolisthesis"
  | "marrow"
  | "ligament"
  | "knee"
  | "shoulder"
  | "brain"
  | "chest"
  | "misc"
  | "field_strength"
  | "technique"
  | "free_text";

export interface ParseResult {
  findings:      ExpandedFinding[];
  unknownTokens: string[];
  modality:      string;
  region:        string;
}

// Shared dict entry type — used by all dictionaries
type DictEntry = { text: string; type: FindingCategory; isOpinion?: boolean };

export interface CustomAbbreviation {
  abbreviation: string;
  findingText: string;
  opinionText?: string;
  category?: string;
}

export interface BuiltinAbbreviation {
  key: string;
  abbreviation: string;
  scope: string;
  findingText: string;
  opinionText?: string;
  category: FindingCategory;
}

// ─────────────────────────────────────────────
// AUTO-OPINION MAP
// Maps every finding abbreviation to its O-prefix
// opinion equivalent. When a finding is parsed,
// its opinion is automatically added to OPINION POINTS.
// Radiologist does not need to type the O-prefix.
// ─────────────────────────────────────────────

/**
 * Auto-opinion map.
 * For every finding abbreviation that has an O-prefix equivalent, map it here.
 * When a finding is parsed, its opinion equivalent is automatically added to
 * opinion points — no need for radiologist to type it.
 */
const AUTO_OPINION_MAP: Record<string, string> = {
  // Lumbar spondylolisthesis — lytic
  "L1 l1": "OL1 l1",
  "L2 l1": "OL2 l1",
  "L3 l1": "OL3 l1", "L3 l2": "OL3 l2",
  "L4 l1": "OL4 l1", "L4 l2": "OL4 l2",
  "L5 l1": "OL5 l1", "L5 l2": "OL5 l2",
  "L4 L5 l": "OL4 L5 l1",
  // Lumbar spondylolisthesis — degenerative
  "L1 d1": "OL1 d1",
  "L2 d1": "OL2 d1",
  "L3 d1": "OL3 d1", "L3 d2": "OL3 d2",
  "L4 d1": "OL4 d1", "L4 d2": "OL4 d2",
  "L5 D1": "OL5 D1", "L5 d2": "OL5 d2",
  "L4 L5 d": "OL4 L5 d1",
  // Spondylosis
  "CS": "OCS", "DS": "ODS", "LS": "OLS",
  // Knee
  "ACLtear":     "OACLtear",
  "ACLpartial":  "OACLpartial",
  "ACLsprain":   "OACLsprain",
  "acl sprain":  "OACLsprain",
  "ACLmucoid":   "OACLmucoid",
  "PCLsprain":   "OPCLsprain",
  "PCLmucoid":   "OPCLmucoid",
  "PCLpartial":  "OPCLpartial",
  "PCLtear":     "OPCLtear",
  "PHMM1":       "OPHMM1",
  "PHMM2":       "OPHMM2",
  "PHMMmounting": "OPHMMmounting",
  "PHMMtear":    "OPHMMtear",
  "PHMMroot":    "OPHMMroot",
  "PHMMbucket":  "OPHMMbucket",
  "phmm bucket": "OPHMMbucket",
  "AHMM1":       "OAHMM1",
  "AHMM2":       "OAHMM2",
  "AHMMtear":    "OAHMMtear",
  "PHLM1":       "OPHLM1",
  "PHLM2":       "OPHLM2",
  "PHLMtear":    "OPHLMtear",
  "AHLM1":       "OAHLM1",
  "AHLM2":       "OAHLM2",
  "AHLMtear":    "OAHLMtear",
  "MCL1":        "OMCL1",
  "mcl gr 1":    "OMCL1",
  "MCL2":        "OMCL2",
  "mcl gr 2":    "OMCL2",
  "MCLtear":     "OMCLtear",
  "LCL1":        "OLCL1",
  "LCL2":        "OLCL2",
  "LCLtear":     "OLCLtear",
  "mild je":     "Omild je",
  // Shoulder
  "SST":         "OSST",
  "SStear":      "OSStear",
  "SSpwtear":    "OSSpwtear",
  "SSpartial":   "OSSpartial",
  "IST":         "OIST",
  "IStear":      "OIStear",
  "ISpartial":   "OISpartial",
  "SubST":       "OSubST",
  "SubStear":    "OSubStear",
  "SubSpartial": "OSubSpartial",
  // Brain
  "No areas":    "ONo areas",
  "CIF":         "OCIF",
  "SAD":         "OSAD",
  "OSADCIF":     "OOSADCIF",
  "BIC":         "OBIC",
  "IIH":         "OIIH",
};

/** Case-insensitive lookup in AUTO_OPINION_MAP */
function lookupAutoOpinion(raw: string): string | undefined {
  const lower = raw.toLowerCase();
  for (const [key, val] of Object.entries(AUTO_OPINION_MAP)) {
    if (key.toLowerCase() === lower) return val;
  }
  return undefined;
}

/** Push an auto-opinion finding if the O-key exists in the dict and isn't already present */
function pushAutoOpinion(
  raw: string,
  findings: ExpandedFinding[],
  dict: Record<string, DictEntry>
): void {
  const oKey = lookupAutoOpinion(raw);
  if (!oKey) return;
  const opTokens = oKey.split(/\s+/);
  const opMatch  = findLongestMatch(opTokens, 0, dict);
  if (!opMatch) return;
  // De-duplicate: skip if this opinion text is already queued
  const alreadyPresent = findings.some(
    f => f.isOpinion && f.expanded === opMatch.entry.text
  );
  if (alreadyPresent) return;
  findings.push({
    raw:       oKey,
    expanded:  opMatch.entry.text,
    type:      opMatch.entry.type,
    isOpinion: true,
    isUnknown: false,
  });
}

// ─────────────────────────────────────────────
// DISC SHORT OPINION MAP
// Maps disc abbreviations to short diagnosis names.
// Used with a spine level to build "L4/5 right posterolateral disc protrusion."
// ─────────────────────────────────────────────

const DISC_SHORT_OPINION: Record<string, string> = {
  // Lumbar disc — protrusions
  "lpdp":      "posterior disc protrusion",
  "lcpdp":     "central posterior disc protrusion",
  "lprp":      "posterior and right posterolateral disc protrusion",
  "lplp":      "posterior and left posterolateral disc protrusion",
  "lrp":       "right posterolateral disc protrusion",
  "llp":       "left posterolateral disc protrusion",
  // Lumbar disc — herniations
  "lpdh":      "posterior disc herniation",
  "lprh":      "right posterolateral disc herniation",
  "lplh":      "left posterolateral disc herniation",
  // Lumbar disc — bulges
  "lpdb":      "posterior disc bulge",
  "mild lpdb": "mild posterior disc bulge",
  // Cervical disc — protrusions
  "cpdp":       "posterior disc protrusion",
  "small cpdp": "small central posterior disc protrusion",
  "cprp":       "right posterolateral disc protrusion",
  "cplp":       "left posterolateral disc protrusion",
  // Cervical disc — herniations
  "cpdh":       "central posterior disc herniation",
  "cprh":       "right posterolateral disc herniation",
  "cplh":       "left posterolateral disc herniation",
  // Cervical disc — bulges
  "cpdb":       "posterior disc bulge",
  "mild cpdb":  "mild posterior disc bulge",
};

/** Push a level-prefixed disc opinion if the abbreviation is in DISC_SHORT_OPINION */
function pushDiscOpinion(
  level: string,
  abbrTokens: string[],
  findings: ExpandedFinding[]
): void {
  const abbr  = abbrTokens.join(" ").toLowerCase();
  const short = DISC_SHORT_OPINION[abbr];
  if (!short) return;
  const opinionText = `${level} ${short}.`;
  const alreadyPresent = findings.some(
    f => f.isOpinion && f.expanded === opinionText
  );
  if (alreadyPresent) return;
  findings.push({
    raw:       `O${level} ${abbr}`,
    expanded:  opinionText,
    type:      abbr.startsWith("c") ? "disc_cervical" : "disc_lumbar",
    isOpinion: true,
    isUnknown: false,
  });
}

// ─────────────────────────────────────────────
// YOUR ACTUAL ABBREVIATION DICTIONARIES
// Source: Word_Abbreviations.docx
// ─────────────────────────────────────────────

// ── CERVICAL & DORSAL SPINE ──────────────────

const CERVICAL_DORSAL: Record<string, DictEntry> = {
  "CS": {
    text: "Cervical spondylosis evident by small marginal osteophytic lipping of the opposing vertebral endplates and reduced bright T2 signal of the intervertebral discs denoting degeneration.",
    type: "spondylosis"
  },
  "OCS": {
    text: "Cervical spondylosis.",
    type: "spondylosis",
    isOpinion: true,
  },
  "DS": {
    text: "Dorsal spondylosis evident by small marginal osteophytic lipping of the opposing vertebral endplates and reduced bright T2 signal of the intervertebral discs denoting degeneration.",
    type: "spondylosis"
  },
  "ODS": {
    text: "Dorsal spondylosis.",
    type: "spondylosis",
    isOpinion: true,
  },
  "No disc": {
    text: "No evidence of significant disc bulge or herniation.",
    type: "disc_cervical"
  },
  // Cervical disc — protrusions
  "cpdp": {
    text: "Central posterior disc protrusion seen effacing the ventral CSF space and indenting the cord.",
    type: "disc_cervical"
  },
  "small cpdp": {
    text: "Small central posterior disc protrusion seen effacing the ventral CSF space and abutting the cord.",
    type: "disc_cervical"
  },
  "cprp": {
    text: "Posterior and right posterolateral disc protrusion seen effacing the ventral CSF space, indenting the cord and encroaching upon right neural exit pathway.",
    type: "disc_cervical"
  },
  "cplp": {
    text: "Posterior and left posterolateral disc protrusion seen effacing the ventral CSF space, indenting the cord and encroaching upon left neural exit pathway.",
    type: "disc_cervical"
  },
  // Cervical disc — herniations
  "cpdh": {
    text: "Central posterior disc herniation seen effacing the ventral CSF space, indenting the cord and encroaching upon neural exit pathways.",
    type: "disc_cervical"
  },
  "cprh": {
    text: "Posterior and right posterolateral disc herniation seen effacing the ventral CSF space, indenting the cord and encroaching upon right neural exit pathway.",
    type: "disc_cervical"
  },
  "cplh": {
    text: "Posterior and left posterolateral disc herniation seen effacing the ventral CSF space, indenting the cord and encroaching upon left neural exit pathway.",
    type: "disc_cervical"
  },
  // Cervical disc — bulges
  "cpdb": {
    text: "Diffuse posterior disc bulge seen effacing the ventral CSF space, indenting the cord and slightly encroaching upon related neural exit pathways.",
    type: "disc_cervical"
  },
  "mild cpdb": {
    text: "Mild posterior disc bulge seen effacing the ventral CSF space, not touching the cord and slightly encroaching upon related neural exit pathways.",
    type: "disc_cervical"
  },
  // Cervical marrow / cord
  "No marrow": { text: "No marrow infiltrative lesions.", type: "marrow" },
  "CCM": {
    text: "Focal intramedullary patchy area of abnormal high T2 signal seen within the cord substance opposite C level. No related cord expansion.",
    type: "disc_cervical"
  },
  // Shared phrases
  "VEP":  { text: "vertebral endplates", type: "free_text" },
  "VEPS": { text: "vertebral endplates Schmorl's nodes.", type: "marrow" },
  "NCA":  { text: "neurocentral arthropathy", type: "free_text" },
};

// ── LUMBAR SPINE ─────────────────────────────

const LUMBAR: Record<string, DictEntry> = {
  "LS": {
    text: "Lumbar spondylosis evident by small marginal osteophytic lipping of the opposing vertebral endplates and reduced bright T2 signal of the intervertebral discs denoting degeneration.",
    type: "spondylosis"
  },
  "OLS": {
    text: "Lumbar spondylosis.",
    type: "spondylosis",
    isOpinion: true,
  },
  "No disc": { text: "No evidence of significant disc bulge or herniation.", type: "disc_lumbar" },
  // Spondylolisthesis — lytic (pars breaks)
  "L1 l1": {
    text: "Mild forward slippage of L1 over L2 vertebra secondary to bilateral L1 pars interarticularis breaks.",
    type: "spondylolisthesis"
  },
  "L2 l1": {
    text: "Mild forward slippage of L2 over L3 vertebra secondary to bilateral L2 pars interarticularis breaks.",
    type: "spondylolisthesis"
  },
  "L3 l1": {
    text: "Mild forward slippage of L3 over L4 vertebra secondary to bilateral L3 pars interarticularis breaks.",
    type: "spondylolisthesis"
  },
  "L3 l2": {
    text: "Forward slippage of L3 over L4 vertebra secondary to bilateral L3 pars interarticularis breaks.",
    type: "spondylolisthesis"
  },
  "L4 l1": {
    text: "Minimal forward slippage of L4 over L5 vertebra secondary to bilateral L4 pars interarticularis breaks.",
    type: "spondylolisthesis"
  },
  "L5 l1": {
    text: "Minimal forward slippage of L5 over the sacrum secondary to bilateral L5 pars interarticularis breaks.",
    type: "spondylolisthesis"
  },
  "L5 l2": {
    text: "Forward slippage of L5 over the sacrum secondary to bilateral L5 pars interarticularis breaks.",
    type: "spondylolisthesis"
  },
  // Spondylolisthesis — degenerative (facetal)
  "L1 d1": {
    text: "Mild forward slippage of L1 over L2 vertebra secondary to L1/2 facetal arthropathy.",
    type: "spondylolisthesis"
  },
  "L2 d1": {
    text: "Mild forward slippage of L2 over L3 vertebra secondary to L2/3 facetal arthropathy.",
    type: "spondylolisthesis"
  },
  "L3 d1": {
    text: "Mild forward slippage of L3 over L4 vertebra secondary to L3/4 facetal arthropathy.",
    type: "spondylolisthesis"
  },
  "L3 d2": {
    text: "Forward slippage of L3 over L4 vertebra secondary to L3/4 facetal arthropathy.",
    type: "spondylolisthesis"
  },
  "L4 d1": {
    text: "Minimal forward slippage of L4 over L5 vertebra secondary to L4/5 facetal arthropathy.",
    type: "spondylolisthesis"
  },
  "L4 d2": {
    text: "Forward slippage of L4 over L5 vertebra secondary to L4/5 facetal arthropathy.",
    type: "spondylolisthesis"
  },
  "L5 D1": {
    text: "Minimal forward slippage of L5 over the sacrum secondary to L5/S1 facetal arthropathy.",
    type: "spondylolisthesis"
  },
  "L5 d2": {
    text: "Forward slippage of L5 over the sacrum secondary to L5/S1 facetal arthropathy.",
    type: "spondylolisthesis"
  },
  "L4 L5 d": {
    text: "Mild forward slippage of L4 over L5 and L5 over the sacrum vertebra secondary to L4/5 and L5/S1 facetal arthropathy.",
    type: "spondylolisthesis"
  },
  "L4 L5 l": {
    text: "Mild forward slippage of L4 over L5 and L5 over the sacrum vertebra secondary to bilateral L4 and L5 pars interarticularis breaks.",
    type: "spondylolisthesis"
  },
  // Spondylolisthesis — opinion codes (O prefix)
  "OL1 l1": { text: "L1 first degree lytic spondylolisthesis.",              type: "spondylolisthesis", isOpinion: true },
  "OL2 l1": { text: "L2 first degree lytic spondylolisthesis.",              type: "spondylolisthesis", isOpinion: true },
  "OL3 l1": { text: "L3 first degree lytic spondylolisthesis.",              type: "spondylolisthesis", isOpinion: true },
  "OL3 l2": { text: "L3 second degree lytic spondylolisthesis.",             type: "spondylolisthesis", isOpinion: true },
  "OL4 l1": { text: "L4 first degree lytic spondylolisthesis.",              type: "spondylolisthesis", isOpinion: true },
  "OL4 l2": { text: "L4 second degree lytic spondylolisthesis.",             type: "spondylolisthesis", isOpinion: true },
  "OL5 l1": { text: "L5 first degree lytic spondylolisthesis.",              type: "spondylolisthesis", isOpinion: true },
  "OL5 l2": { text: "L5 second degree lytic spondylolisthesis.",             type: "spondylolisthesis", isOpinion: true },
  "OL1 d1": { text: "L1 first degree degenerative spondylolisthesis.",       type: "spondylolisthesis", isOpinion: true },
  "OL2 d1": { text: "L2 first degree degenerative spondylolisthesis.",       type: "spondylolisthesis", isOpinion: true },
  "OL3 d1": { text: "L3 first degree degenerative spondylolisthesis.",       type: "spondylolisthesis", isOpinion: true },
  "OL3 d2": { text: "L3 second degree degenerative spondylolisthesis.",      type: "spondylolisthesis", isOpinion: true },
  "OL4 d1": { text: "L4 first degree degenerative spondylolisthesis.",       type: "spondylolisthesis", isOpinion: true },
  "OL4 d2": { text: "L4 second degree degenerative spondylolisthesis.",      type: "spondylolisthesis", isOpinion: true },
  "OL5 D1": { text: "L5 first degree degenerative spondylolisthesis.",       type: "spondylolisthesis", isOpinion: true },
  "OL5 d2": { text: "L5 second degree degenerative spondylolisthesis.",      type: "spondylolisthesis", isOpinion: true },
  "OL4 L5 d1": { text: "L4 and L5 double level first degree degenerative spondylolisthesis.", type: "spondylolisthesis", isOpinion: true },
  "OL4 L5 l1": { text: "L4 and L5 double level first degree lytic spondylolisthesis.",        type: "spondylolisthesis", isOpinion: true },
  // Lumbar disc — protrusions
  "lpdp": {
    text: "Posterior disc protrusion seen effacing the ventral epidural fat, indenting the theca and slightly encroaching upon related neural exit pathways.",
    type: "disc_lumbar"
  },
  "lcpdp": {
    text: "Central posterior disc protrusion seen effacing the ventral epidural fat and gently indenting the theca.",
    type: "disc_lumbar"
  },
  "lprp": {
    text: "Posterior and right posterolateral disc protrusion seen effacing the ventral epidural fat, indenting the theca and encroaching upon neural exit pathway.",
    type: "disc_lumbar"
  },
  "lplp": {
    text: "Posterior and left posterolateral disc protrusion seen effacing the ventral epidural fat, indenting the theca and encroaching upon neural exit pathways.",
    type: "disc_lumbar"
  },
  "lrp": {
    text: "Right posterolateral disc protrusion seen encroaching upon right neural exit pathway.",
    type: "disc_lumbar"
  },
  "llp": {
    text: "Left posterolateral disc protrusion seen encroaching upon right neural exit pathway.",
    type: "disc_lumbar"
  },
  // Lumbar disc — herniations
  "lpdh": {
    text: "Posterior disc herniation seen effacing the ventral epidural fat, indenting the theca and slightly encroaching upon related neural exit pathways.",
    type: "disc_lumbar"
  },
  "lprh": {
    text: "Posterior and right posterolateral disc herniation seen effacing the ventral epidural fat, indenting the theca and encroaching upon right neural exit pathway.",
    type: "disc_lumbar"
  },
  "lplh": {
    text: "Posterior and left posterolateral disc herniation seen effacing the ventral epidural fat, indenting the theca and encroaching upon left neural exit pathway.",
    type: "disc_lumbar"
  },
  // Lumbar disc — bulges
  "lpdb": {
    text: "Diffuse posterior disc bulge seen effacing the ventral epidural fat, indenting the theca and slightly encroaching upon related neural exit pathways.",
    type: "disc_lumbar"
  },
  "mild lpdb": {
    text: "Mild posterior disc bulge seen effacing the ventral epidural fat, abutting the theca and slightly encroaching upon related neural exit pathways.",
    type: "disc_lumbar"
  },
  // Lumbar other
  "blf": {
    text: "Buckled ligamenta flava and bilateral facetal arthropathy seen adding to spinal canal tightness.",
    type: "ligament"
  },
  "Transitional": {
    text: "Transitional lumbosacral vertebra considered as sacralized L5 vertebra.",
    type: "free_text"
  },
  "VEP":       { text: "vertebral endplates", type: "free_text" },
  "VEPS":      { text: "vertebral endplates Schmorl's nodes.", type: "marrow" },
  "No marrow": { text: "No marrow infiltrative lesions.", type: "marrow" },
};

// ── KNEE ─────────────────────────────────────

const KNEE: Record<string, DictEntry> = {
  "Knee oa": {
    text: "Osteoarthritic changes of the knee joint manifested by marginal osteophytic lipping with subchondral marrow degenerative changes of the articular condyles and patellar poles as well as denudation of the articular cartilage.",
    type: "knee"
  },
  "Irregular thinning": {
    text: "Irregular thinning and denudation of the articular cartilage overlying patellar articular facet with underlying patellar marrow edema signal.",
    type: "knee"
  },
  "Subtle fissuring": {
    text: "Subtle fissuring and elevated signal of the patellar articular cartilage with no underlying patellar marrow edema signal.",
    type: "knee"
  },
  "OC": {
    text: "Small osteochondral injury of the medial femoral trochlea with underlying patchy marrow edema displaying high STIR signal.",
    type: "knee"
  },
  // Medial meniscus
  "PHMM": { text: "posterior horn of medial meniscus", type: "knee" },
  "PHMM1": {
    text: "The posterior horn of medial meniscus shows intrasubstance band of increased signal not reaching meniscocapsular attachment or interrupting articular surfaces.",
    type: "knee"
  },
  "PHMM2": {
    text: "The posterior horn of medial meniscus shows intrasubstance band of increased signal reaching meniscocapsular attachment but not interrupting articular surfaces.",
    type: "knee"
  },
  "PHMMmounting": {
    text: "The posterior horn of medial meniscus shows intrasubstance band of increased signal reaching meniscocapsular attachment and abutting inferior articular surface.",
    type: "knee"
  },
  "PHMMtear": {
    text: "The posterior horn of medial meniscus shows intrasubstance increased signal interrupting its articular surfaces.",
    type: "knee"
  },
  "PHMMroot": {
    text: "The posterior horn of medial meniscus shows intrasubstance increased signal interrupting its root attachment with mild meniscal extrusion.",
    type: "knee"
  },
  "PHMMbucket": {
    text: "Attenuated body and posterior horn of medial meniscus show intrasubstance area of high signal intensity interrupting the meniscal articular surfaces with associated unstable meniscal fragment seen displaced into the intercondylar region.",
    type: "knee"
  },
  "AHMM": { text: "anterior horn of medial meniscus", type: "knee" },
  "AHMM1": {
    text: "The anterior horn of medial meniscus shows intrasubstance band of increased signal not reaching meniscocapsular attachment or interrupting articular surfaces.",
    type: "knee"
  },
  "AHMM2": {
    text: "The anterior horn of medial meniscus shows intrasubstance band of increased signal reaching meniscocapsular attachment but not interrupting articular surfaces.",
    type: "knee"
  },
  "AHMMtear": {
    text: "The anterior horn of medial meniscus shows intrasubstance band of increased signal interrupting articular surfaces.",
    type: "knee"
  },
  // Medial meniscus — opinion
  "OPHMM1":        { text: "Grade I signal of the posterior horn of medial meniscus.",                             type: "knee", isOpinion: true },
  "OPHMM2":        { text: "Grade II signal of the posterior horn of medial meniscus.",                            type: "knee", isOpinion: true },
  "OPHMMmounting": { text: "Degenerated posterior horn of medial meniscus mounting to small inferior surface tear.", type: "knee", isOpinion: true },
  "OPHMMtear":     { text: "Torn posterior horn of medial meniscus.",                                               type: "knee", isOpinion: true },
  "OPHMMroot":     { text: "Root tear of the posterior horn of medial meniscus.",                                   type: "knee", isOpinion: true },
  "OPHMMbucket":   { text: "Bucket handle tear of the posterior horn of medial meniscus.",                          type: "knee", isOpinion: true },
  "OAHMM1":        { text: "Grade I signal of the anterior horn of medial meniscus.",                              type: "knee", isOpinion: true },
  "OAHMM2":        { text: "Grade II signal of the anterior horn of medial meniscus.",                             type: "knee", isOpinion: true },
  "OAHMMtear":     { text: "Torn anterior horn of medial meniscus.",                                                type: "knee", isOpinion: true },
  // Lateral meniscus
  "PHLM": { text: "posterior horn of lateral meniscus", type: "knee" },
  "PHLM1": {
    text: "The posterior horn of lateral meniscus shows intrasubstance band of increased signal not reaching meniscocapsular attachment or interrupting articular surfaces.",
    type: "knee"
  },
  "PHLM2": {
    text: "The posterior horn of lateral meniscus shows intrasubstance band of increased signal reaching meniscocapsular attachment but not interrupting articular surfaces.",
    type: "knee"
  },
  "PHLMtear": {
    text: "The posterior horn of lateral meniscus shows intrasubstance band of increased signal interrupting articular surfaces.",
    type: "knee"
  },
  "AHLM": { text: "anterior horn of lateral meniscus", type: "knee" },
  "AHLM1": {
    text: "The anterior horn of lateral meniscus shows intrasubstance band of increased signal not reaching meniscocapsular attachment or interrupting articular surfaces.",
    type: "knee"
  },
  "AHLM2": {
    text: "The anterior horn of lateral meniscus shows intrasubstance band of increased signal reaching meniscocapsular attachment but not interrupting articular surfaces.",
    type: "knee"
  },
  "AHLMtear": {
    text: "The anterior horn of lateral meniscus shows intrasubstance band of increased signal interrupting articular surfaces.",
    type: "knee"
  },
  "OPHLM1":    { text: "Grade I signal of the posterior horn of lateral meniscus.", type: "knee", isOpinion: true },
  "OPHLM2":    { text: "Grade II signal of the posterior horn of lateral meniscus.", type: "knee", isOpinion: true },
  "OPHLMtear": { text: "Torn posterior horn of lateral meniscus.",                   type: "knee", isOpinion: true },
  "OAHLM1":    { text: "Grade I signal of the anterior horn of lateral meniscus.",  type: "knee", isOpinion: true },
  "OAHLM2":    { text: "Grade II signal of the anterior horn of lateral meniscus.", type: "knee", isOpinion: true },
  "OAHLMtear": { text: "Torn anterior horn of lateral meniscus.",                   type: "knee", isOpinion: true },
  // Collateral ligaments
  "MCL":  { text: "medial collateral ligament", type: "knee" },
  "MCL1": {
    text: "Minimal fluid signal seen encasing the intact medial collateral ligament.",
    type: "knee"
  },
  "mcl gr 1": {
    text: "Minimal fluid signal seen encasing the intact medial collateral ligament.",
    type: "knee"
  },
  "MCL2": {
    text: "The medial collateral ligament appears mildly thickened showing mild increased signal near its femoral attachment yet no fibers interruption.",
    type: "knee"
  },
  "mcl gr 2": {
    text: "The medial collateral ligament appears mildly thickened showing mild increased signal near its femoral attachment yet no fibers interruption.",
    type: "knee"
  },
  "MCLtear": {
    text: "The medial collateral ligament appears thickened showing fuzzy outline with increased signal interrupting its femoral attachment.",
    type: "knee"
  },
  "OMCL1": { text: "Grade I injury of the medial collateral ligament.",  type: "knee", isOpinion: true },
  "OMCL2": { text: "Grade II injury of the medial collateral ligament.", type: "knee", isOpinion: true },
  "OMCLtear": { text: "Tear of the medial collateral ligament.", type: "knee", isOpinion: true },
  "LCL":  { text: "lateral collateral ligament", type: "knee" },
  "LCL1": {
    text: "Minimal fluid signal seen encasing the intact lateral collateral ligament.",
    type: "knee"
  },
  "LCL2": {
    text: "The lateral collateral ligament appears mildly thickened showing mild increased signal near its femoral attachment yet no fibers interruption.",
    type: "knee"
  },
  "LCLtear": {
    text: "The lateral collateral ligament appears thickened showing fuzzy outline with increased signal interrupting its femoral attachment.",
    type: "knee"
  },
  "OLCL1": { text: "Grade I injury of the lateral collateral ligament.",  type: "knee", isOpinion: true },
  "OLCL2": { text: "Grade II injury of the lateral collateral ligament.", type: "knee", isOpinion: true },
  "OLCLtear": { text: "Tear of the lateral collateral ligament.", type: "knee", isOpinion: true },
  // Cruciate ligaments
  "ACL": { text: "anterior cruciate ligament", type: "knee" },
  "ACLsprain": {
    text: "The anterior cruciate ligament appears mildly thickened showing intrasubstance increased signal yet no fibers interruption.",
    type: "knee"
  },
  "acl sprain": {
    text: "The anterior cruciate ligament appears mildly thickened showing intrasubstance increased signal yet no fibers interruption.",
    type: "knee"
  },
  "ACLtear": {
    text: "The anterior cruciate ligament appears thickened with fuzzy outline showing intrasubstance increased signal interrupting its fibers with sagging of its distal fibers over tibial plateau.",
    type: "knee"
  },
  "ACLpartial": {
    text: "The anterior cruciate ligament appears thickened with fuzzy outline showing intrasubstance increased signal partially interrupting its fibers with no complete tear.",
    type: "knee"
  },
  "ACLmucoid": {
    text: "The anterior cruciate ligament appears diffusely thickened showing fuzzy outline with intrasubstance increased signal yet no complete fibers interruption.",
    type: "knee"
  },
  "OACLsprain":  { text: "Anterior cruciate ligament sprain.",                                        type: "knee", isOpinion: true },
  "phmm bucket": {
    text: "Attenuated body and posterior horn of medial meniscus show intrasubstance area of high signal intensity interrupting the meniscal articular surfaces with associated unstable meniscal fragment seen displaced into the intercondylar region.",
    type: "knee"
  },
  "mild je": { text: "Mild joint effusion.", type: "knee" },
  "Omild je": { text: "Mild joint effusion.", type: "knee", isOpinion: true },
  "OACLpartial": { text: "Anterior cruciate ligament partial thickness tear.",                         type: "knee", isOpinion: true },
  "OACLtear":    { text: "Anterior cruciate ligament full thickness tear.",                            type: "knee", isOpinion: true },
  "OACLmucoid":  { text: "Anterior cruciate ligament mucoid degeneration/chronic interstitial injury.", type: "knee", isOpinion: true },
  "PCL": { text: "posterior cruciate ligament", type: "knee" },
  "PCLsprain": {
    text: "The posterior cruciate ligament appears mildly thickened showing intrasubstance increased signal yet no fibers interruption.",
    type: "knee"
  },
  "PCLmucoid": {
    text: "The posterior cruciate ligament appears diffusely thickened showing fuzzy outline with intrasubstance increased signal yet no complete fibers interruption.",
    type: "knee"
  },
  "PCLpartial": {
    text: "The posterior cruciate ligament appears thickened with fuzzy outline showing intrasubstance increased signal partially interrupting its fibers with no complete tear.",
    type: "knee"
  },
  "PCLtear": {
    text: "The posterior cruciate ligament appears thickened with fuzzy outline showing intrasubstance increased signal interrupting its fibers with sagging of its distal fibers over tibial plateau.",
    type: "knee"
  },
  "OPCLsprain": { text: "Posterior cruciate ligament sprain.", type: "knee", isOpinion: true },
  "OPCLmucoid": { text: "Posterior cruciate ligament mucoid degeneration.", type: "knee", isOpinion: true },
  "OPCLpartial": { text: "Posterior cruciate ligament partial thickness tear.", type: "knee", isOpinion: true },
  "OPCLtear": { text: "Posterior cruciate ligament full thickness tear", type: "knee", isOpinion: true },
  "BC":        { text: "with Baker's cyst formation", type: "knee" },
  "No marrow": { text: "No marrow infiltrative lesions.", type: "marrow" },
};

// ── SHOULDER ─────────────────────────────────

const SHOULDER: Record<string, DictEntry> = {
  "acoa": {
    text: "Acromioclavicular osteoarthritis evident by cortical irregularities of the opposing articular surfaces and hypertrophied joint capsule seen encroaching upon the subacromial fat.",
    type: "shoulder"
  },
  "SST": {
    text: "The supraspinatus tendon appears mildly thickened showing increased intrasubstance signal yet no fibers interruption. No tendon retraction or muscle atrophic changes.",
    type: "shoulder"
  },
  "SStear": {
    text: "The supraspinatus tendon is interrupted at its humeral insertion being replaced by fluid-filled gap displaying low T1W and high T2W and extending for about -- cm associated with tendon retraction and muscle atrophic changes.",
    type: "shoulder"
  },
  "SSpwtear": {
    text: "The supraspinatus tendon shows focal interruption of its anterior fibers near its humeral insertion being replaced by fluid-filled gap. Associated tendon retraction with mild muscle atrophic changes.",
    type: "shoulder"
  },
  "SSpartial": {
    text: "The supraspinatus tendon appears mildly thickened showing increased intrasubstance signal abutting its inferior/articular fibers at its humeral insertion yet no complete fibers interruption. No tendon retraction or muscle atrophic changes.",
    type: "shoulder"
  },
  "IST": {
    text: "The infraspinatus tendon appears mildly thickened showing increased intrasubstance signal yet no fibers interruption. No tendon retraction or muscle atrophic changes.",
    type: "shoulder"
  },
  "IStear": {
    text: "The infraspinatus tendon is interrupted at its humeral insertion being replaced by fluid-filled gap displaying low T1W and high T2W and extending for about -- cm associated with tendon retraction and muscle atrophic changes.",
    type: "shoulder"
  },
  "ISpartial": {
    text: "The infraspinatus tendon appears mildly thickened showing increased intrasubstance signal abutting its inferior/articular fibers at its humeral insertion yet no complete fibers interruption. No tendon retraction or muscle atrophic changes.",
    type: "shoulder"
  },
  "SubST": {
    text: "The subscapularis tendon appears mildly thickened showing increased intrasubstance signal yet no fibers interruption. No tendon retraction or muscle atrophic changes.",
    type: "shoulder"
  },
  "SubStear": {
    text: "The subscapularis tendon is interrupted at its humeral insertion being replaced by fluid-filled gap displaying low T1W and high T2W and extending for about -- cm associated with tendon retraction and muscle atrophic changes.",
    type: "shoulder"
  },
  "SubSpartial": {
    text: "The subscapularis tendon appears mildly thickened showing increased intrasubstance signal abutting its inferior/articular fibers at its humeral insertion yet no complete fibers interruption. No tendon retraction or muscle atrophic changes.",
    type: "shoulder"
  },
  "ssb":  { text: "Subacromial/subdeltoid bursa", type: "shoulder" },
  "lhbt": {
    text: "The intra-articular part of the long head of biceps tendon appears mildly thickened showing increased signal yet no fibers interruption.",
    type: "shoulder"
  },
  "OSST":     { text: "Supraspinatus tendinosis.",                          type: "shoulder", isOpinion: true },
  "OSStear":  { text: "Supraspinatus full thickness tear.",                  type: "shoulder", isOpinion: true },
  "OSSpwtear":{ text: "Supraspinatus partial width full thickness tear.",    type: "shoulder", isOpinion: true },
  "OSSpartial": { text: "Supraspinatus inferior/articular surface partial thickness tear.", type: "shoulder", isOpinion: true },
  "OIST": { text: "Infraspinatus tendinosis.", type: "shoulder", isOpinion: true },
  "OIStear": { text: "Infraspinatus full thickness tear.", type: "shoulder", isOpinion: true },
  "OISpartial": { text: "Infraspinatus inferior/articular surface partial thickness tear.", type: "shoulder", isOpinion: true },
  "OSubST": { text: "Subscapularis tendinosis.", type: "shoulder", isOpinion: true },
  "OSubStear": { text: "Subscapularis full thickness tear.", type: "shoulder", isOpinion: true },
  "OSubSpartial": { text: "Subscapularis inferior/articular surface partial thickness tear.", type: "shoulder", isOpinion: true },
  "Small subcortical": {
    text: "Small subcortical pseudocystic changes of the humeral head.",
    type: "shoulder"
  },
};

// ── BRAIN ────────────────────────────────────

const BRAIN: Record<string, DictEntry> = {
  "No areas": {
    text: "No areas of diffusion restriction distinctive for acute ischemic insult.",
    type: "brain"
  },
  "CIF": {
    text: "Bilateral cerebral small periventricular and subcortical foci of high T2 and FLAIR signal are seen neither surrounded by edema nor exerting mass effect.",
    type: "brain"
  },
  "SAD": {
    text: "Bilateral periventricular sheets of high T2/FLAIR signal.",
    type: "brain"
  },
  "OSADCIF": {
    text: "Bilateral cerebral periventricular and subcortical small foci and patches of high T2 and FLAIR signal are seen neither surrounded by edema nor exerting mass effect.",
    type: "brain"
  },
  "BIC": {
    text: "Prominent ventricular system and extra axial CSF spaces namely the cortical sulci, basal cistern and sylvian fissures.",
    type: "brain"
  },
  "Cavum": { text: "Cavum septum pellucidum (variant).", type: "brain" },
  "ONo areas": { text: "No evidence of recent ischemic insult.", type: "brain", isOpinion: true },
  "OCIF":  { text: "Bilateral cerebral ischemic foci.",   type: "brain", isOpinion: true },
  "OSAD":  { text: "Small artery disease.", type: "brain", isOpinion: true },
  "OOSADCIF": { text: "Small artery disease with bilateral cerebral ischemic foci.", type: "brain", isOpinion: true },
  "OBIC":  { text: "Brain involutional changes.",          type: "brain", isOpinion: true },
  "NSX":   { text: "Prominent nasopharyngeal tissue.",     type: "brain" },
  "IIH": {
    text: "Partial empty sella with prominent peri-optic CSF signal.",
    type: "brain"
  },
  "OIIH": {
    text: "Partial empty sella with prominent peri-optic CSF signal, for clinical correlation to assess the possibility of idiopathic intracranial hypertension.",
    type: "brain",
    isOpinion: true,
  },
  "Enlarged nasopharyngeal": {
    text: "Enlarged nasopharyngeal adenoid seen encroaching upon nasopharyngeal air column.",
    type: "brain"
  },
};

// ── CHEST ────────────────────────────────────

const CHEST: Record<string, DictEntry> = {
  "No pulmonary": {
    text: "No pulmonary consolidation, cavitation or bronchiectatic changes.",
    type: "chest"
  },
  "No pneumonia": {
    text: "No CT features to indicate pneumonia.",
    type: "chest"
  },
};

// ── MISCELLANEOUS / TECHNIQUE ────────────────

const MISC: Record<string, DictEntry> = {
  "** A marker": {
    text: "** A marker was placed over the region of patient complain.",
    type: "misc"
  },
  "** For progress,": {
    text: "** For progress, kindly correlate with previous unavailable studies.",
    type: "misc"
  },
  "fu": {
    text: "** Follow-up study with correlation to the previous study dated //",
    type: "misc"
  },
  "fus": {
    text: "Follow-up study running rather stationary course since last study dated // as described.",
    type: "misc"
  },
  // Field strength
  "ex": { text: "EXTREMITY (1.5 TESLA)",       type: "field_strength" },
  "op": { text: "OPEN (1.0 TESLA)",             type: "field_strength" },
  "hi": { text: "HIGH FIELD (3.0 TESLA)",       type: "field_strength" },
  // Technique
  "Ws*":     { text: "WITH WHOLE SPINE SAGITTAL T2 FILM",                                type: "technique" },
  "Limited": { text: "LIMITED MRI OF THE BRAIN WITH DIFFUSION",                          type: "technique" },
  "Ms*":     { text: "Multiple MR sequences were taken in different planes.",             type: "technique" },
  "Tec*":    { text: "MRI TECHNIQUE: Multiple MR sequences were taken in different planes.", type: "technique" },
};

// ── SHARED SIGNAL PHRASES (used inline, not as standalone tokens) ────

export const SHARED_PHRASES: Record<string, string> = {
  "Reduced bright":    "Reduced bright T2 signal of the intervertebral discs denoting degeneration.",
  "Relatively reduced":"Relatively reduced bright T2 signal of the intervertebral discs denoting degeneration.",
  "Rather preserved":  "Rather preserved bright T2 signal of the intervertebral discs.",
};

// ─────────────────────────────────────────────
// REGION → DICTIONARY MAPPING
// ─────────────────────────────────────────────

function getDictionary(region: string): Record<string, DictEntry> {
  const r = region.toUpperCase();
  if (r.includes("CERVICAL") || r.includes("DORSAL"))
    return { ...CERVICAL_DORSAL, ...MISC };
  if (r.includes("LUMBAR") || r.includes("LUMBOSACRAL"))
    return { ...LUMBAR, ...MISC };
  if (r === "KNEE" || r.includes("KNEE"))
    return { ...KNEE, ...MISC };
  if (r === "SHOULDER" || r.includes("SHOULDER"))
    return { ...SHOULDER, ...MISC };
  if (r === "BRAIN" || r.includes("CNS") || r.includes("BRAIN"))
    return { ...BRAIN, ...MISC };
  if (r === "CHEST" || r.includes("CHEST"))
    return { ...CHEST, ...MISC };
  // Fallback: all dicts merged
  return {
    ...CERVICAL_DORSAL, ...LUMBAR, ...KNEE,
    ...SHOULDER, ...BRAIN, ...CHEST, ...MISC
  };
}

export function listBuiltinAbbreviations(): BuiltinAbbreviation[] {
  const scoped: Array<[string, Record<string, DictEntry>]> = [
    ["Cervical / Dorsal Spine", CERVICAL_DORSAL],
    ["Lumbar Spine", LUMBAR],
    ["Knee", KNEE],
    ["Shoulder", SHOULDER],
    ["Brain", BRAIN],
    ["Chest", CHEST],
    ["General", MISC],
  ];
  const all = { ...CERVICAL_DORSAL, ...LUMBAR, ...KNEE, ...SHOULDER, ...BRAIN, ...CHEST, ...MISC };
  return scoped.flatMap(([scope, dict]) => Object.entries(dict)
    .filter(([, entry]) => !entry.isOpinion)
    .map(([abbreviation, entry]) => {
      const opinionKey = lookupAutoOpinion(abbreviation);
      const opinionEntry = opinionKey
        ? Object.entries(all).find(([key]) => key.toLowerCase() === opinionKey.toLowerCase())?.[1]
        : undefined;
      return {
        key: `${scope}:${abbreviation}`,
        abbreviation,
        scope,
        findingText: entry.text,
        opinionText: opinionEntry?.text,
        category: entry.type,
      };
    }));
}

// ─────────────────────────────────────────────
// LEVEL PREFIX DETECTOR
// Handles: L4/5, C5/6, L5S1, c56, T6/7, etc.
// ─────────────────────────────────────────────

export function detectSpineLevel(token: string): string | null {
  const t = token.toUpperCase().trim();
  // Standard slash: C5/6, L4/5, L5/S1, T6/7
  const slashMatch = t.match(/^([CLT])(\d+)\/(S?\d+)$/);
  if (slashMatch) return `${slashMatch[1]}${slashMatch[2]}/${slashMatch[3]}`;
  // Dash separator: L4-5, L5-S1, C5-6 (common radiologist shorthand)
  const dashMatch = t.match(/^([CLT])(\d+)-(S?\d+)$/);
  if (dashMatch) return `${dashMatch[1]}${dashMatch[2]}/${dashMatch[3]}`;
  // Compressed: c56, l45, l5s1
  const compMatch = t.match(/^([CLT])(\d)(S?\d)$/);
  if (compMatch) {
    const lower = compMatch[3].startsWith("S")
      ? compMatch[3]
      : compMatch[1] + compMatch[3];
    return `${compMatch[1]}${compMatch[2]}/${lower}`;
  }
  return null;
}

// ─────────────────────────────────────────────
// MULTI-WORD TOKEN LOOKUP
// Some abbreviations are multi-word (e.g. "mild lpdb", "small cpdp")
// Try longest match first.
// ─────────────────────────────────────────────

function findLongestMatch(
  tokens: string[],
  startIndex: number,
  dict: Record<string, DictEntry>
): { entry: DictEntry; consumed: number } | null {
  const longestKey = Math.min(
    8,
    Math.max(3, ...Object.keys(dict).map((key) => key.trim().split(/\s+/).length))
  );
  for (let len = longestKey; len >= 1; len--) {
    const candidate = tokens.slice(startIndex, startIndex + len).join(" ");
    // Case-sensitive first (abbreviations are case-sensitive: "No marrow" != "no marrow")
    if (dict[candidate]) return { entry: dict[candidate], consumed: len };
    // Case-insensitive fallback for convenience
    const lower = candidate.toLowerCase();
    const found = Object.entries(dict).find(([k]) => k.toLowerCase() === lower);
    if (found) return { entry: found[1], consumed: len };
  }
  return null;
}

// ─────────────────────────────────────────────
// MAIN PARSER
// ─────────────────────────────────────────────

/**
 * Parse radiologist abbreviations into structured findings.
 *
 * Input format:
 *   - One finding per line OR comma-separated OR all on one line
 *   - For disc levels: spine level followed by abbreviation
 *     e.g. "L4/5 lpdh" or "C5/6 cprp" — can appear mid-line
 *   - Standalone abbreviations: "CS", "OCIF", "ACLtear"
 *
 * @param rawText  - Free text with abbreviations
 * @param modality - "MRI" | "CT" | "XR" | "US"
 * @param region   - "CERVICAL" | "LUMBAR" | "DORSAL" | "KNEE" | "SHOULDER" | "BRAIN" | "CHEST"
 */
export function parseAbbreviations(
  rawText: string,
  modality: string,
  region: string,
  customAbbreviations: CustomAbbreviation[] = []
): ParseResult {
  const customDict = Object.fromEntries(customAbbreviations.map((entry) => [
    entry.abbreviation,
    { text: entry.findingText, type: "misc" as FindingCategory },
  ]));
  const customByKey = new Map(customAbbreviations.map((entry) => [entry.abbreviation.toLowerCase(), entry]));
  const dict          = { ...getDictionary(region), ...customDict };
  const findings:      ExpandedFinding[] = [];
  const unknownTokens: string[]          = [];

  const lines = rawText
    .split(/\n|,/)
    .map(l => l.trim())
    .filter(Boolean);

  for (const line of lines) {
    const tokens = line.trim().split(/\s+/);
    if (!tokens.length) continue;

    // ── Unified scanning loop ────────────────────────────────────────────────
    // Handles three cases in one pass:
    //   1. Line starts with level: "L4/5 lpdh"
    //   2. Level appears mid-line: "LS L4/5 lpdh OL4 d1 OLS"
    //   3. No level: "CS OCIF BIC"

    let i = 0;
    while (i < tokens.length) {
      // ── Check if current token is a spine level ───────────────────────────
      const level = detectSpineLevel(tokens[i]);

      if (level && i + 1 < tokens.length) {
        // Try to match the token(s) following the level
        const afterLevel = tokens.slice(i + 1);
        const match      = findLongestMatch(afterLevel, 0, dict);
        if (match) {
          const matchedTokens = afterLevel.slice(0, match.consumed);
          const spineRaw = `${tokens[i]} ${matchedTokens.join(" ")}`;
          findings.push({
            raw:       spineRaw,
            expanded:  `${level} ${match.entry.text}`,
            type:      match.entry.type,
            isOpinion: match.entry.isOpinion,
          });
          // Auto-add opinion equivalent if the finding has one (spondylosis/spondylolisthesis)
          pushAutoOpinion(spineRaw, findings, dict);
          // Auto-add short disc opinion (e.g. "L4/5 right posterolateral disc protrusion.")
          pushDiscOpinion(level, matchedTokens, findings);
          i += 1 + match.consumed;
          continue;
        }
        // Level token had no following match — fall through to normal lookup
        // (level itself will be an unknown token)
      }

      // ── Normal multi-word abbreviation match ──────────────────────────────
      const match = findLongestMatch(tokens, i, dict);
      if (match) {
        const raw = tokens.slice(i, i + match.consumed).join(" ");
        findings.push({
          raw,
          expanded:  match.entry.text,
          type:      match.entry.type,
          isOpinion: match.entry.isOpinion,
        });
        const custom = customByKey.get(raw.toLowerCase());
        if (custom?.opinionText && !findings.some((finding) => finding.isOpinion && finding.expanded === custom.opinionText)) {
          findings.push({ raw: `O${raw}`, expanded: custom.opinionText, type: "misc", isOpinion: true });
        }
        // Custom entries own their opinion wording. Built-in auto-opinion is
        // used only when no database override exists for this abbreviation.
        if (!custom) pushAutoOpinion(raw, findings, dict);
        i += match.consumed;
      } else {
        // Unknown token — pass through as free text
        findings.push({
          raw:       tokens[i],
          expanded:  tokens[i],
          type:      "free_text",
          isUnknown: true,
        });
        unknownTokens.push(tokens[i]);
        i++;
      }
    }
  }

  return { findings, unknownTokens, modality, region };
}

// ─────────────────────────────────────────────
// OUTPUT FORMATTER
// ─────────────────────────────────────────────

/**
 * Converts parsed findings into prompt text for the AI.
 *
 * Structured findings → "use these phrases exactly"
 * Opinion points      → "use as your OPINION bullets" (bold, pre-formatted)
 * Free text           → "incorporate naturally"
 */
export function toPromptString(result: ParseResult): string {
  if (!result.findings.length) return "";

  const noRecentIschemia = "No evidence of recent ischemic insult.";
  const noDiffusionRestriction = "No areas of diffusion restriction distinctive for acute ischemic insult.";
  const structured    = result.findings
    .filter(f => !f.isUnknown && !f.isOpinion)
    .sort((a, b) => Number(b.expanded === noDiffusionRestriction) - Number(a.expanded === noDiffusionRestriction));
  const opinionPoints = result.findings
    .filter(f => !f.isUnknown &&  f.isOpinion)
    .sort((a, b) => Number(b.expanded === noRecentIschemia) - Number(a.expanded === noRecentIschemia));
  const freeText      = result.findings.filter(f =>  f.isUnknown);

  const lines: string[] = [];

  if (structured.length) {
    lines.push(
      "STRUCTURED FINDINGS (pre-parsed — use these phrases exactly, do not rephrase):"
    );
    structured.forEach(f => lines.push(`- ${f.expanded}`));
  }

  if (opinionPoints.length) {
    lines.push("");
    lines.push(
      "OPINION POINTS (use these exact phrases as your OPINION bullets, do not rephrase):"
    );
    opinionPoints.forEach(f => lines.push(`- **${f.expanded}**`));
  }

  if (freeText.length) {
    lines.push("");
    lines.push("ADDITIONAL FINDINGS (incorporate naturally):");
    freeText.forEach(f => lines.push(`- ${f.expanded}`));
  }

  if (result.unknownTokens.length) {
    lines.push(
      `\n[Unrecognised tokens: ${result.unknownTokens.join(", ")}]`
    );
  }

  return lines.join("\n");
}

/** One-call shortcut — returns empty string if nothing was expanded */
export function parseToPrompt(raw: string, modality: string, region: string, customAbbreviations: CustomAbbreviation[] = []): string {
  const result = parseAbbreviations(raw, modality, region, customAbbreviations);

  // If nothing was actually expanded, return "" so the caller falls back to raw findings
  const hasExpanded = result.findings.some(f => !f.isUnknown && f.raw !== f.expanded);
  if (!hasExpanded) return "";

  return toPromptString(result);
}

/** For live preview UI — returns token-by-token expansions */
export function getLiveExpansions(raw: string, modality: string, region: string) {
  const result = parseAbbreviations(raw, modality, region);
  return result.findings.map(f => ({
    raw:       f.raw,
    expanded:  f.expanded,
    type:      f.type,
    isUnknown: !!f.isUnknown,
    isOpinion: !!f.isOpinion,
  }));
}

/*
────────────────────────────────────────────────
USAGE EXAMPLES

// Cervical spine
parseToPrompt("CS\nC5/6 cprp\nC6/7 cpdh\nNo marrow", "MRI", "CERVICAL")

Output:
  STRUCTURED FINDINGS (pre-parsed...):
  - Cervical spondylosis evident by small marginal osteophytic lipping...
  - C5/6 Posterior and right posterolateral disc protrusion seen effacing...
  - C6/7 Central posterior disc herniation seen effacing the ventral CSF space...
  - No marrow infiltrative lesions.

// Lumbar spine (all on one line)
parseToPrompt("LS L4/5 lpdh OL4 d1 OLS blf No marrow", "MRI", "Lumbar Spine")

Output:
  STRUCTURED FINDINGS:
  - Lumbar spondylosis evident by...
  - L4/5 Posterior disc herniation seen effacing...
  - Buckled ligamenta flava and bilateral facetal arthropathy...
  - No marrow infiltrative lesions.

  OPINION POINTS:
  - **L4 first degree degenerative spondylolisthesis.**
  - **Lumbar spondylosis.**

// Knee
parseToPrompt("PHMM2\nACLtear\nOACLtear\nBC\nOPHMM2", "MRI", "KNEE")

// Brain
parseToPrompt("CIF\nOCIF\nBIC\nOBIC", "MRI", "BRAIN")
────────────────────────────────────────────────
*/

