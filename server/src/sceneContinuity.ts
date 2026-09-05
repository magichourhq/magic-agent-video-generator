import type { Scene, VideoPlan } from "./schemas.js";

const STATE_STOP_WORDS = new Set([
  "a", "an", "and", "are", "at", "by", "for", "from", "in", "is", "it", "of", "on", "or",
  "the", "their", "this", "to", "with", "same", "scene", "shot", "camera", "frame", "setting",
  "member",
]);
const TOKEN_ALIASES: Record<string, string> = {
  automobile: "car",
  sedan: "car",
  vehicle: "car",
};
const TEXT_ONLY_FRAME =
  /\b(title card|text[- ]only|black screen|blank screen|solid (?:black|white|color) background|emoji[- ]only|large (?:title|text|letters)|words? (?:on|over) (?:a )?(?:black|blank|solid) (?:screen|background))\b/i;
const GENERATED_READABLE_TEXT =
  /\b(?:sign|flyer|poster|screen|label|card|banner|newspaper|letter)\b[^.!?\n]{0,60}\b(?:reads?|says?|showing the words?)\b|\b(?:written|printed|displayed)\s+(?:text|words?|date|year)\b/i;
const CAUSAL_CAMERA_REFRAME =
  /\b(?:whip[- ]?pan|camera (?:tilts?|pans?|swings?|reframes?)|cut(?:s|ting)? (?:to|away)|snap zoom|rack focus)\b/i;
const COMPLETED_CAUSAL_CONTACT =
  /\b(?:catch|catches|caught|land|lands|landed|makes? contact|secure|secures|secured|hold|holds|held|cradl(?:e|es|ed|ing)|rests? (?:across|on))\b/i;
const TURNAROUND =
  /\b(turns? around|reverses? direction|walks? back|runs? back|faces? the other way|changes? direction)\b/i;
const ANIMATE_SUBJECT =
  /\b(baby|babies|infant|child|children|boy|girl|woman|women|man|men|person|people|dog|cat|horse|bird|animal|elephant)\b/gi;
const ANIMATE_SUBJECT_PRESENT =
  /\b(baby|babies|infant|child|children|boy|girl|woman|women|man|men|person|people|dog|cat|horse|bird|animal|elephant)\b/i;
const ANIMATE_IDENTITY_TOKENS = new Set([
  "baby", "babie", "infant", "child", "children", "boy", "girl", "woman", "women", "man", "men",
  "person", "people", "dog", "cat", "horse", "bird", "animal", "elephant",
]);
const CHILD_REFERENCE =
  /\b(baby|babies|infant|infants|child|children|boy|boys|girl|girls|son|daughter|he|she|him|her|they|them)\b/i;
const HUMAN_REFERENCE =
  /\b(woman|women|man|men|person|people|adult|creator|worker|he|she|him|her|they|them)\b/i;
const SUBJECT_INTRODUCTION =
  /\b(arrive|arrives|enter|enters|walks? in|runs? in|approach|approaches|join|joins|appear|appears|emerge|emerges|fall|falls|tumble|tumbles|descend|descends|drop|drops|is revealed)\b/i;
const UNSHOWN_STATE_CHANGE =
  /\b(between scenes?|off[- ]?screen|off camera|outside (?:the )?frame|not shown|has been handed off|was handed off|has already left|has already arrived)\b/i;
const EXPLICIT_TIME_OR_PLACE_BRIDGE =
  /\b(?:moments?|seconds?|minutes?|hours?|days?|weeks?|months?|years?) later\b|\b(?:a|one|\d+)\s+(?:days?|weeks?|months?|years?)\s+(?:pass|passes|passed|has passed)\b|\b(?:the )?next (?:morning|day|night|week|month|year)\b|\bmeanwhile\b|\belsewhere\b|\bnew (?:place|location|room|city|country|planet)\b/i;
const VERTICAL_ORIGIN =
  /\b(?:from|beneath|below|under|above|over|out of|off)\b.{0,50}\b(?:window|roof|ledge|balcony|fire escape|stair|tree|sky|building|upper floor|fourth[- ]story|height)\b|\b(?:window|roof|ledge|balcony|fire escape|upper floor|fourth[- ]story)\b.{0,30}\b(?:above|overhead)\b/i;
const VERTICAL_DESTINATION =
  /\b(?:toward|towards|into|onto|down to|above|over|directly over|directly above)\b|\b(?:ground|street|sidewalk|arms|hands|shoulders?|back|catcher|landing point) below\b/i;
const FALLING_ACTION = /\b(fall|falls|fell|falling|drop|drops|dropped|descend|descends|descending|tumble|tumbles|plunge|plunges)\b/i;
const HYPOTHETICAL_FALLING_ACTION =
  /\b(?:imagine|picture|suppose|what if|could|might|would)\b[^.!?\n]{0,96}\b(?:fall|falls|fell|falling|drop|drops|dropped|descend|descends|descending|tumble|tumbles)\b/i;
const FALL_OUTCOME_REFERENCE =
  /\b(?:surviv\w*|safe|unharmed|recover\w*|remember\w*|react\w*|stunned|aftermath)\b.{0,64}\b(?:after|following|from|through)?\s*(?:the|both|two|earlier|previous)?\s*(?:falls?|drops?|descents?|impacts?)\b/gi;
const AIRBORNE_STAGING =
  /\b(mid[- ]?air|airborne|suspended|descending|falling|above|between|before (?:contact|impact|the catch)|approaching)\b/i;
const COMPLETED_FALL_FRAME =
  /\b(?:caught|cradl(?:e|es|ed|ing)|already landed|after (?:the )?(?:fall|catch|impact)|making contact|rests? (?:across|on) (?:his|her|their|the) shoulders?|held safely|holds?|holding|carries|carrying)\b/i;
const CAUSAL_ACTIONS = [
  /\b(fall|falls|fell|falling|tumble|tumbles|tumbled|drop|drops|dropped|plunge|plunges|plunged)\b/i,
  /\b(catch|catches|caught|land|lands|landed|impact|impacts|hit|hits|crash|crashes|crashed|collide|collides)\b/i,
  /\b(arrive|arrives|arrived|enter|enters|entered|leave|leaves|left|depart|departs|exits?)\b/i,
] as const;
const ARRIVAL_ACTION = /\b(arrive|arrives|arrived|enter|enters|entered|approach|approaches|walks? in|runs? in)\b/i;
const DEPARTURE_ACTION = /\b(leave|leaves|left|depart|departs|departed|exit|exits|exited|walks? away|runs? away)\b/i;
const HANDOFF_ACTION =
  /\bhand(?:s|ed|ing)? (?:over|off)\b|\bhand(?:s|ed|ing)?\s+(?:a|an|the|his|her|their)\s+[^.!?\n]{1,60}\s+to\b|\b(?:give|gives|gave|given|pass|passes|passed|transfer|transfers|transferred)\s+(?:a|an|the|his|her|their|it|him|them)\b/i;
const POUR_ACTION = /\b(?:pour|pours|poured|pouring|fill|fills|filled|filling)\b/i;
const PICKUP_ACTION =
  /\b(?:pick|picks|picked|picking)\s+up\b|\b(?:lift|lifts|lifted|lifting|grab|grabs|grabbed|grabbing)\b/i;
const PLACE_ACTION =
  /\b(?:put|puts|putting|place|places|placed|placing|lower|lowers|lowered|lowering)\b|\bset(?:s|ting)?\s+down\b/i;
const OPEN_CLOSE_ACTION =
  /\b(?:open|opens|opened|opening|close|closes|closed|closing|unseal|unseals|unlock|unlocks)\b/i;
const POSTURE_ACTION =
  /\b(?:sit|sits|sat|sitting|stand|stands|stood|standing|kneel|kneels|knelt|rise|rises|rose)\b/i;
const CONSUME_ACTION =
  /\b(?:drink|drinks|drank|drinking|sip|sips|sipped|sipping|eat|eats|ate|eating|bite|bites|biting)\b/i;
const OPERATE_ACTION =
  /\b(?:use|uses|used|using|tap|taps|tapped|press|presses|pressed|turns? on|switches? on|type|types|typed|typing)\b/i;

function hasActiveFallingAction(text: string): boolean {
  return FALLING_ACTION.test(text.replace(FALL_OUTCOME_REFERENCE, " "));
}

function hasLiteralNarratedFallingAction(text: string): boolean {
  return hasActiveFallingAction(text) && !HYPOTHETICAL_FALLING_ACTION.test(text);
}

function scenePerformsFallingAction(scene: Scene): boolean {
  return hasActiveFallingAction(`${scene.continuity.story_beat} ${scene.video_prompt}`);
}

function normalizedTokens(value: string): string[] {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9_\s-]/g, " ")
    .split(/\s+/)
    .map((token) => token.replace(/(?:'s|s)$/i, ""))
    .map((token) => TOKEN_ALIASES[token] ?? token)
    .filter((token) => token.length > 2 && !/^\d{3,4}$/.test(token) && !STATE_STOP_WORDS.has(token));
}

function tokenSet(value: string): Set<string> {
  return new Set(normalizedTokens(value));
}

function overlapRatio(left: string, right: string): number {
  const a = tokenSet(left);
  const b = tokenSet(right);
  if (a.size === 0 || b.size === 0) return 0;
  let common = 0;
  for (const token of a) if (b.has(token)) common += 1;
  return common / Math.min(a.size, b.size);
}

function similarityRatio(left: string, right: string): number {
  const a = tokenSet(left);
  const b = tokenSet(right);
  if (a.size === 0 || b.size === 0) return 0;
  let common = 0;
  for (const token of a) if (b.has(token)) common += 1;
  return common / (a.size + b.size - common);
}

function subjectVisible(scene: Scene, subject: string, visualBible = ""): boolean {
  const subjectTokens = normalizedTokens(subject);
  if (subjectTokens.length === 0) return true;
  const visibleTokens = tokenSet(
    `${scene.image_prompt} ${scene.continuity.opening_state} ${scene.continuity.closing_state} ${scene.continuity.setting}`,
  );
  const visibleCount = subjectTokens.filter((token) => visibleTokens.has(token)).length;
  if (/\bsetting\b/i.test(subject)) return visibleCount >= 1;
  const isProperName = /(?:^|\s)[A-Z][a-z]+\s+[A-Z][a-z]+(?:\s|$)/.test(subject.trim());
  const bibleTokens = tokenSet(visualBible);
  if (
    isProperName &&
    subjectTokens.every((token) => bibleTokens.has(token)) &&
    visibleCount >= 1
  ) {
    return true;
  }
  if (subjectTokens.length <= 2) return visibleCount === subjectTokens.length;
  return visibleCount >= Math.ceil(subjectTokens.length * 0.5);
}

function narratedAnimateSubjects(scene: Scene): string[] {
  const beatSubjects = [...scene.continuity.story_beat.matchAll(ANIMATE_SUBJECT)].map((match) => match[0]!.toLowerCase());
  const narrationTokens = tokenSet(scene.narration);
  const namedHumanMentioned = scene.continuity.required_subjects.some((subject) =>
    normalizedTokens(subject).some(
      (token) => !ANIMATE_IDENTITY_TOKENS.has(token) && narrationTokens.has(token),
    ),
  );
  return [...new Set(beatSubjects)].filter((subject) => {
    if (/\b(baby|babies|infant|child|children|boy|girl)\b/i.test(subject)) {
      return !CHILD_REFERENCE.test(scene.narration);
    }
    if (/\b(woman|women|man|men|person|people)\b/i.test(subject)) {
      return !HUMAN_REFERENCE.test(scene.narration) && !namedHumanMentioned;
    }
    return !new RegExp(`\\b${subject}\\b`, "i").test(scene.narration);
  });
}

function animateSubjectPresent(subject: string, state: string): boolean {
  const identityTokens = normalizedTokens(subject).filter((token) => ANIMATE_IDENTITY_TOKENS.has(token));
  if (identityTokens.length === 0) return true;
  const stateTokens = tokenSet(state);
  return identityTokens.every((token) => stateTokens.has(token));
}

function sharedTrackedSubject(left: Scene, right: Scene): boolean {
  return left.continuity.required_subjects.some((leftSubject) =>
    right.continuity.required_subjects.some((rightSubject) => overlapRatio(leftSubject, rightSubject) >= 0.5),
  );
}

export function shouldChainPreviousKeyframe(plan: VideoPlan, sceneIndex: number): boolean {
  if (sceneIndex <= 0 || sceneIndex >= plan.scenes.length) return false;
  const previous = plan.scenes[sceneIndex - 1]!;
  const current = plan.scenes[sceneIndex]!;
  const bridgeText = `${current.continuity.story_beat} ${current.continuity.opening_state}`;
  if (EXPLICIT_TIME_OR_PLACE_BRIDGE.test(bridgeText)) return false;
  if (!sharedTrackedSubject(previous, current)) return false;
  return (
    overlapRatio(previous.continuity.setting, current.continuity.setting) >= 0.3 ||
    /\bsame\b/i.test(`${current.continuity.setting} ${current.continuity.opening_state}`)
  );
}

export function identityReferenceSceneIndex(plan: VideoPlan, sceneIndex: number): number | null {
  if (sceneIndex <= 0 || sceneIndex >= plan.scenes.length) return null;
  const current = plan.scenes[sceneIndex]!;
  for (let index = 0; index < sceneIndex; index += 1) {
    if (sharedTrackedSubject(plan.scenes[index]!, current)) return index;
  }
  return null;
}

function fallContactTarget(scene: Scene): string {
  const event = `${scene.continuity.story_beat} ${scene.video_prompt} ${scene.continuity.closing_state}`;
  if (/\bshoulders?\b/i.test(event)) return "the receiving adult's shoulders";
  if (/\b(?:arms?|cradl(?:e|es|ed|ing))\b/i.test(event)) return "the receiving adult's waiting arms";
  if (/\bhands?\b/i.test(event)) return "the receiving adult's waiting hands";
  return "the declared contact point on the receiving adult";
}

function fallReceiverPose(scene: Scene): string {
  if (/\bshoulders?\b/i.test(fallContactTarget(scene))) {
    return "braces with knees slightly bent, shoulders directly under the descent, and hands raised beside the shoulders to steady the subject after contact";
  }
  return "looks upward and begins raising both arms toward the descent";
}

export function causalMotionInstruction(scene: Scene): string {
  const isFalling = scenePerformsFallingAction(scene);
  if (!isFalling) return scene.video_prompt;
  const groundedClauses = scene.video_prompt
    .split(/(?<=[.!?;])\s+|,\s*/)
    .filter((clause) => clause.trim() && !CAUSAL_CAMERA_REFRAME.test(clause))
    .join(". ")
    .replace(/\s+/g, " ")
    .trim();
  const completion = COMPLETED_CAUSAL_CONTACT.test(
    `${groundedClauses} ${scene.continuity.closing_state}`,
  )
    ? ""
    : `The descending subject reaches ${fallContactTarget(scene)}, and the receiving adult visibly secures the subject before the shot ends.`;
  return [groundedClauses, completion].filter(Boolean).join(" ");
}

export function effectiveSceneOpeningState(
  scene: Scene,
  options: { providerSafeMinor?: boolean } = {},
): string {
  if (!hasActiveFallingAction(scene.continuity.story_beat)) return scene.continuity.opening_state;
  const contactTarget = fallContactTarget(scene);
  const receiverPose = fallReceiverPose(scene);
  if (options.providerSafeMinor) {
    return (
      `At ${scene.continuity.setting}, a securely wrapped infant-sized rescue bundle with no exposed face or skin is ` +
      `visibly suspended just below the clearly visible upper-story origin on a gentle downward path toward ${contactTarget}. ` +
      `The receiving adult stands directly below and ${receiverPose}. Clear empty space remains before contact.`
    );
  }
  if (
    AIRBORNE_STAGING.test(scene.continuity.opening_state) &&
    !COMPLETED_FALL_FRAME.test(scene.continuity.opening_state)
  ) {
    return scene.continuity.opening_state;
  }
  const subjects = scene.continuity.required_subjects.join(" and ");
  return (
    `At ${scene.continuity.setting}, ${subjects} occupy one coherent vertical axis: ` +
    "the elevated origin is visible above, the fully clothed falling subject is airborne below it, " +
    `and the receiving person is below, ${receiverPose}, with ${contactTarget} aligned under the descent and clear empty space before contact.`
  );
}

export function scenePhysicsContext(
  plan: VideoPlan,
  scene: Scene,
  options: {
    openingKeyframeOnly?: boolean;
    providerSafeMinor?: boolean;
    globalWorldAnchors?: string;
  } = {},
): string {
  const sceneIndex = plan.scenes.findIndex((item) => item.id === scene.id);
  const previous = sceneIndex > 0 ? plan.scenes[sceneIndex - 1] : null;
  const next = sceneIndex >= 0 && sceneIndex < plan.scenes.length - 1 ? plan.scenes[sceneIndex + 1] : null;
  const directContinuation = previous ? shouldChainPreviousKeyframe(plan, sceneIndex) : false;
  const directHandoff = next ? shouldChainPreviousKeyframe(plan, sceneIndex + 1) : false;
  const worldAnchors = options.globalWorldAnchors ?? plan.visual_bible.trim();
  const requiredSubjects = options.providerSafeMinor
    ? scene.continuity.required_subjects.map((subject) =>
        /\b(baby|babies|infant|child|children|boy|girl)\b/i.test(subject)
          ? "securely wrapped infant-sized rescue bundle with no exposed face or skin"
          : subject,
      )
    : scene.continuity.required_subjects;
  const parts = [
    worldAnchors ? `Global world anchors: ${worldAnchors}` : "",
    previous && directContinuation
      ? `Previous scene exit (continuity history, not a second frame): ${previous.continuity.closing_state}`
      : "",
    `Current scene entry: ${effectiveSceneOpeningState(scene, options)}`,
    `Current physical setting: ${scene.continuity.setting}`,
    requiredSubjects.length > 0
      ? `Required visible people and objects: ${requiredSubjects.join("; ")}`
      : "",
    options.openingKeyframeOnly ? "" : `Chronological event: ${scene.continuity.story_beat}`,
    options.openingKeyframeOnly ? "" : `State after this scene's motion: ${scene.continuity.closing_state}`,
    !options.openingKeyframeOnly && next && directHandoff
      ? `Next scene handoff target: ${next.continuity.opening_state}. End this scene in a compatible physical state, but do not begin the next scene's action.`
      : "",
    scene.continuity.screen_direction !== "not_applicable"
      ? `Persistent screen direction: ${scene.continuity.screen_direction.replaceAll("_", " ")}`
      : "",
  ];
  return parts.filter(Boolean).join(". ");
}

export function causalGeometryGuidance(scene: Scene): string {
  if (!scenePerformsFallingAction(scene)) return "";
  const contactTarget = fallContactTarget(scene);
  return (
    "Gravity geometry: keep the elevated origin, descending subject, and destination in one coherent vertical axis. " +
    "Use one continuous wide or gently tracking view that keeps the origin, full downward path, receiver, and contact point visible. " +
    `The subject moves downward from the visible origin toward ${contactTarget} below; never depict a horizontal launch, throwing pose, unexplained sideways trajectory, or disappearance. ` +
    "Complete the declared catch or landing before the final second and finish with the subject visibly secured at the declared closing state."
  );
}

export function causalOpeningKeyframeGuidance(
  scene: Scene,
  options: { providerSafeMinor?: boolean } = {},
): string {
  if (!scenePerformsFallingAction(scene)) return "";
  if (options.providerSafeMinor) {
    const contactTarget = fallContactTarget(scene);
    return [
      `Safety-staged opening keyframe: ${effectiveSceneOpeningState(scene, options)}`,
      "Show exactly one calm pre-contact reenactment instant with the wrapped rescue bundle, receiving adult, and elevated origin in one coherent vertical composition.",
      `The wrapped bundle must be clearly visible in the opening frame, separated from the adult, and aligned vertically with ${contactTarget} below.`,
    ].join(" ");
  }
  return [
    `Animation-ready opening keyframe: ${effectiveSceneOpeningState(scene)}`,
    "Show exactly one pre-contact instant: the fully clothed falling subject is airborne just below the visible elevated origin, vertically separated from the person below.",
    "The person below is looking upward and beginning to raise their arms; clear empty space remains between them.",
    "The falling subject is visibly moving downward toward the person below, before contact.",
  ].join(" ");
}

export function realWorldStagingGuidance(scene: Scene): string {
  const action = `${scene.continuity.story_beat} ${scene.video_prompt}`;
  const base =
    "Real-world blocking: show one photographable entry instant. Every body and object has plausible scale, weight, support, reach, gaze, and contact; cause happens before reaction; nothing teleports, duplicates, morphs, or changes possession off-screen.";

  if (scenePerformsFallingAction(scene)) {
    return `${base} Keep the elevated origin, downward path, receiving person, contact point, and secured result physically connected in the same space.`;
  }
  if (HANDOFF_ACTION.test(action)) {
    return `${base} The giver begins holding one object within the receiver's reach; the receiver grasps it before the giver releases it; the closing state shows that same single object in the receiver's possession.`;
  }
  if (POUR_ACTION.test(action)) {
    return `${base} The source container begins held above an open receptacle; tilting causes one visible stream to flow downward; the receptacle receives it and both vessels remain spatially aligned.`;
  }
  if (PICKUP_ACTION.test(action)) {
    return `${base} The object begins resting on a visible support within reach; the hand approaches, grips, and only then lifts it; the closing state leaves that same object visibly held.`;
  }
  if (PLACE_ACTION.test(action)) {
    return `${base} The object begins visibly held; the hand lowers it onto a real support surface, releases it, and the closing state leaves it resting there.`;
  }
  if (OPEN_CLOSE_ACTION.test(action)) {
    return `${base} The person begins within reach of the real handle, lid, or control; the hand makes contact before the hinged or sliding part follows its physical axis to a clearly changed end state.`;
  }
  if (ARRIVAL_ACTION.test(action) || DEPARTURE_ACTION.test(action)) {
    return `${base} Use one unobstructed path and a visible threshold or destination; begin before the crossing and finish after it while preserving scale and screen direction.`;
  }
  if (POSTURE_ACTION.test(action)) {
    return `${base} Ground the body on the floor, chair, or other support; show a believable weight shift through feet, legs, and seat without anatomical distortion.`;
  }
  if (CONSUME_ACTION.test(action)) {
    return `${base} The food or drink begins in hand or within reach; the hand brings it naturally to the mouth and the closing state shows a small credible result without duplicating the item.`;
  }
  if (OPERATE_ACTION.test(action)) {
    return `${base} The tool or product begins in hand or within reach; one visible control receives one deliberate input before the observable result occurs.`;
  }
  return base;
}

export function validateSceneContinuity(
  plan: VideoPlan,
  options: { requireLedger?: boolean } = {},
): string[] {
  const issues: string[] = [];
  const multiScene = plan.scenes.length > 1;
  const hasLedger = plan.scenes.some((scene) =>
    Boolean(
      scene.continuity.story_beat.trim() ||
      scene.continuity.opening_state.trim() ||
      scene.continuity.closing_state.trim() ||
      scene.continuity.setting.trim() ||
      scene.continuity.required_subjects.length,
    ),
  );
  const requiresLiteralCausalMotion =
    plan.creative_vibe === "cinematic_commercial" || plan.creative_vibe === "editorial_documentary";
  if (!hasLedger && options.requireLedger !== true) return issues;

  for (const scene of plan.scenes) {
    if (TEXT_ONLY_FRAME.test(scene.image_prompt)) {
      issues.push(`${scene.id} is a title/text/blank-screen frame; replace it with active story footage.`);
    }
    if (GENERATED_READABLE_TEXT.test(scene.image_prompt)) {
      issues.push(
        `${scene.id} asks the image model to render readable text; convey that information through visible action, setting, or narration instead.`,
      );
    }
    if (multiScene && options.requireLedger === true && !scene.continuity.story_beat.trim()) {
      issues.push(`${scene.id} is missing its unique story beat.`);
    }
    if (
      multiScene &&
      options.requireLedger === true &&
      (!scene.continuity.opening_state.trim() || !scene.continuity.closing_state.trim())
    ) {
      issues.push(`${scene.id} must declare concrete opening and closing world states.`);
    }
    if (multiScene && options.requireLedger === true && !scene.continuity.setting.trim()) {
      issues.push(`${scene.id} must declare its physical setting and time.`);
    }
    if (
      UNSHOWN_STATE_CHANGE.test(
        `${scene.continuity.story_beat} ${scene.continuity.opening_state} ${scene.continuity.closing_state}`,
      )
    ) {
      issues.push(
        `${scene.id} hides a character/object movement between scenes; show the bridge on screen or begin after a clean motivated cut without inventing an unseen handoff.`,
      );
    }
    for (const subject of scene.continuity.required_subjects) {
      if (!subjectVisible(scene, subject, plan.visual_bible)) {
        issues.push(
          `${scene.id} requires visible subject "${subject}", but its keyframe/state does not visibly ground that subject.`,
        );
      }
    }
    const hasCausalAction =
      requiresLiteralCausalMotion &&
      CAUSAL_ACTIONS.some((action, index) =>
        index === 0 ? hasActiveFallingAction(scene.continuity.story_beat) : action.test(scene.continuity.story_beat),
      );
    if (hasCausalAction && scene.narration.trim()) {
      const missingNarratedSubjects = narratedAnimateSubjects(scene);
      if (missingNarratedSubjects.length > 0) {
        issues.push(
          `${scene.id} narration omits the active ${missingNarratedSubjects.join(", ")} from its causal story beat; ` +
            "state the event in the spoken line before describing its outcome.",
        );
      }
    }
    const visualActionText = [
      scene.continuity.story_beat,
      scene.video_prompt,
      scene.continuity.closing_state,
      causalGeometryGuidance(scene),
      causalOpeningKeyframeGuidance(scene),
    ].join(" ");
    const narratedActions = [
      {
        active: hasLiteralNarratedFallingAction(scene.narration),
        visible: hasActiveFallingAction(visualActionText),
        label: "falling/descent",
      },
      {
        active: COMPLETED_CAUSAL_CONTACT.test(scene.narration),
        visible: COMPLETED_CAUSAL_CONTACT.test(visualActionText),
        label: "catch/contact",
      },
      {
        active: ARRIVAL_ACTION.test(scene.narration),
        visible: ARRIVAL_ACTION.test(visualActionText),
        label: "arrival/entry",
      },
      {
        active: DEPARTURE_ACTION.test(scene.narration),
        visible: DEPARTURE_ACTION.test(visualActionText),
        label: "departure/exit",
      },
      {
        active: HANDOFF_ACTION.test(scene.narration),
        visible: HANDOFF_ACTION.test(visualActionText),
        label: "handoff/transfer",
      },
    ];
    for (const action of narratedActions) {
      if (action.active && !action.visible) {
        issues.push(
          `${scene.id} narration describes ${action.label}, but that action is absent from the same scene's ` +
            "story beat, motion prompt, and closing state; show the spoken event literally in this scene or rewrite the line.",
        );
      }
    }
    if (
      hasActiveFallingAction(scene.continuity.story_beat) &&
      scene.continuity.required_subjects.some((subject) => ANIMATE_SUBJECT_PRESENT.test(subject))
    ) {
      const compiledKeyframeContext =
        `${scene.image_prompt} ${scene.continuity.story_beat} ${scene.continuity.opening_state} ` +
        `${scene.continuity.closing_state} ${scene.continuity.setting} ${causalGeometryGuidance(scene)} ` +
        causalOpeningKeyframeGuidance(scene);
      if (!VERTICAL_ORIGIN.test(compiledKeyframeContext) || !VERTICAL_DESTINATION.test(compiledKeyframeContext)) {
        issues.push(
          `${scene.id} compiled falling keyframe context lacks explicit physical geometry; visibly include the elevated origin, ` +
            "the airborne subject on a downward path, and the destination below so the subject cannot look horizontally thrown.",
        );
      }
      if (scene.duration_seconds < 8 && COMPLETED_CAUSAL_CONTACT.test(scene.continuity.closing_state)) {
        issues.push(
          `${scene.id} gives a complete fall-and-contact event only ${scene.duration_seconds}s; allocate at least 8s so the ` +
            "origin, trajectory, contact, and secured outcome can all be shown without skipping the result.",
        );
      }
      const compiledMotion = causalMotionInstruction(scene);
      if (CAUSAL_CAMERA_REFRAME.test(compiledMotion)) {
        issues.push(
          `${scene.id} moves or cuts the camera during a required causal event; keep one wide or gently tracking view so ` +
            "the origin, full trajectory, contact, and final secured state remain visible.",
        );
      }
      if (!COMPLETED_CAUSAL_CONTACT.test(`${compiledMotion} ${scene.continuity.closing_state}`)) {
        issues.push(
          `${scene.id} starts a falling event without explicitly completing the catch or landing in the motion prompt and closing state.`,
        );
      }
    }
    for (const subject of scene.continuity.required_subjects) {
      if (
        !animateSubjectPresent(subject, scene.continuity.opening_state) &&
        animateSubjectPresent(subject, scene.continuity.closing_state) &&
        !SUBJECT_INTRODUCTION.test(`${scene.continuity.story_beat} ${scene.video_prompt}`)
      ) {
        issues.push(
          `${scene.id} introduces "${subject}" between its opening and closing state without showing an arrival or entrance; ` +
            "remove the subject or animate how it enters the scene.",
        );
      }
    }
  }

  for (let index = 1; index < plan.scenes.length; index += 1) {
    const previous = plan.scenes[index - 1]!;
    const current = plan.scenes[index]!;
    const previousIsExplicitBridge = EXPLICIT_TIME_OR_PLACE_BRIDGE.test(
      `${previous.continuity.story_beat} ${previous.continuity.closing_state} ${previous.continuity.setting}`,
    );
    const currentIsExplicitBridge = EXPLICIT_TIME_OR_PLACE_BRIDGE.test(
      `${current.continuity.story_beat} ${current.continuity.opening_state} ${current.continuity.setting}`,
    );
    if (
      previous.continuity.story_beat.trim() &&
      current.continuity.story_beat.trim() &&
      similarityRatio(previous.continuity.story_beat, current.continuity.story_beat) >= 0.85
    ) {
      issues.push(`${current.id} repeats ${previous.id}'s story beat instead of advancing the chronology.`);
    }
    if (
      sharedTrackedSubject(previous, current) &&
      !previousIsExplicitBridge &&
      !currentIsExplicitBridge &&
      previous.continuity.closing_state.trim() &&
      current.continuity.opening_state.trim() &&
      overlapRatio(previous.continuity.closing_state, current.continuity.opening_state) < 0.12
    ) {
      issues.push(
        `${current.id} opening state does not inherit enough physical state from ${previous.id}'s closing state; ` +
          "preserve character/object positions or explicitly show the elapsed-time/location bridge.",
      );
    }
    const previousDirection = previous.continuity.screen_direction;
    const currentDirection = current.continuity.screen_direction;
    const reverses =
      (previousDirection === "left_to_right" && currentDirection === "right_to_left") ||
      (previousDirection === "right_to_left" && currentDirection === "left_to_right");
    if (
      reverses &&
      sharedTrackedSubject(previous, current) &&
      !TURNAROUND.test(`${current.continuity.story_beat} ${current.image_prompt} ${current.video_prompt}`)
    ) {
      issues.push(
        `${current.id} reverses a continuing subject's screen direction without an explicit turnaround action.`,
      );
    }
  }

  return issues;
}
