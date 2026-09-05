import { describe, expect, it } from "vitest";
import {
  causalGeometryGuidance,
  causalMotionInstruction,
  causalOpeningKeyframeGuidance,
  realWorldStagingGuidance,
  scenePhysicsContext,
  shouldChainPreviousKeyframe,
  validateSceneContinuity,
} from "../src/sceneContinuity.js";
import type { Scene, VideoPlan } from "../src/schemas.js";

function scene(id: string, overrides: Partial<Scene> = {}): Scene {
  return {
    id,
    narration: "The child reaches the waiting adult.",
    image_prompt: "A child moving left to right toward an adult on the same sunlit sidewalk.",
    video_prompt: "The child takes one step left to right while the camera remains steady.",
    duration_seconds: 5,
    on_camera: false,
    audio_source: null,
    native_audio_prompt: null,
    audio_mode: "cinematic_narrator",
    audio_note: null,
    reference_media_ids: [],
    continuity: {
      story_beat: `${id} advances the child toward the adult.`,
      required_subjects: ["child", "adult"],
      opening_state: "The child and adult remain on the same sunlit sidewalk.",
      closing_state: "The child and adult remain together on the same sunlit sidewalk.",
      setting: "The same sunlit sidewalk in the same afternoon.",
      screen_direction: "left_to_right",
    },
    ...overrides,
  };
}

function plan(scenes: Scene[]): VideoPlan {
  return {
    title: "Continuity test",
    creative_vibe: "cinematic_commercial",
    narration: scenes.map((item) => item.narration).join(" "),
    visual_bible: "One child and one adult in a consistent realistic world.",
    scenes,
    voice: null,
  };
}

describe("scene continuity contract", () => {
  it("accepts a chronological sequence with inherited state", () => {
    expect(validateSceneContinuity(plan([scene("scene_1"), scene("scene_2")]), { requireLedger: true })).toEqual([]);
  });

  it("adds action-specific real-world blocking for physical interactions", () => {
    const pickup = scene("scene_1", {
      image_prompt: "A woman reaches toward a water bottle resting on her desk.",
      video_prompt: "She picks up the water bottle.",
      continuity: {
        ...scene("base").continuity,
        story_beat: "The woman picks up the water bottle from the desk.",
        required_subjects: ["woman", "water bottle", "desk"],
        opening_state: "The bottle rests on the desk within the woman's reach.",
        closing_state: "The woman holds the same bottle in one hand above the desk.",
      },
    });
    const handoff = scene("scene_2", {
      video_prompt: "The woman hands the bottle to her coworker.",
      continuity: {
        ...scene("base").continuity,
        story_beat: "The woman hands the bottle to her coworker.",
      },
    });

    expect(realWorldStagingGuidance(pickup)).toContain("object begins resting on a visible support");
    expect(realWorldStagingGuidance(pickup)).toContain("only then lifts it");
    expect(realWorldStagingGuidance(handoff)).toContain("receiver grasps it before the giver releases it");
  });

  it("does not mistake ordinary walking language for an object pickup", () => {
    const walking = scene("scene_1", {
      video_prompt: "The child takes one careful step toward the adult.",
      continuity: {
        ...scene("base").continuity,
        story_beat: "The child takes one step along the sidewalk.",
      },
    });

    expect(realWorldStagingGuidance(walking)).not.toContain("object begins resting");
  });

  it("carries a continuing scene's next entry state into the motion packet", () => {
    const first = scene("scene_1", {
      continuity: {
        ...scene("base").continuity,
        closing_state: "The child stands beside the adult on the same sunlit sidewalk.",
      },
    });
    const second = scene("scene_2", {
      continuity: {
        ...scene("base").continuity,
        opening_state: "The child stands beside the adult on the same sunlit sidewalk.",
      },
    });

    const context = scenePhysicsContext(plan([first, second]), first);
    expect(context).toContain("Next scene handoff target");
    expect(context).toContain(second.continuity.opening_state);
    expect(context).toContain("do not begin the next scene's action");
  });

  it("rejects a required subject missing from the keyframe and state", () => {
    const issues = validateSceneContinuity(
      plan([
        scene("scene_1", {
          image_prompt: "An empty sunlit sidewalk with a small toy near the curb.",
          continuity: {
            ...scene("base").continuity,
            required_subjects: ["baby"],
            opening_state: "An empty sidewalk.",
            closing_state: "An empty sidewalk.",
          },
        }),
      ]),
      { requireLedger: true },
    );
    expect(issues.join(" ")).toContain('requires visible subject "baby"');
  });

  it("accepts a descriptive subject when its identity and core visual traits are grounded", () => {
    const issues = validateSceneContinuity(
      plan([
        scene("scene_1", {
          image_prompt: "Sarah, a tenant wearing a cream cardigan, reads an email on her smartphone at home.",
          continuity: {
            ...scene("base").continuity,
            required_subjects: ["Sarah, late-30s tenant in cream cardigan"],
            opening_state: "Sarah sits at home in her cream cardigan.",
            closing_state: "Sarah lowers the smartphone after reading the email.",
          },
        }),
      ]),
      { requireLedger: true },
    );

    expect(issues.join(" ")).not.toContain("requires visible subject");
  });

  it("resolves a named character's first-name references through the visual bible", () => {
    const namedPlan = {
      ...plan([
        scene("scene_1", {
          image_prompt: "Joseph sweeps beneath a brick Detroit tenement window.",
          continuity: {
            ...scene("base").continuity,
            required_subjects: ["Joseph Figlock"],
            opening_state: "Joseph stands beneath the same window with his broom.",
            closing_state: "Joseph looks upward and raises both arms.",
            setting: "Detroit sidewalk beneath a brick tenement.",
          },
        }),
      ]),
      visual_bible: "Joseph Figlock is the same dark-haired Detroit worker in every scene.",
    };

    expect(validateSceneContinuity(namedPlan, { requireLedger: true }).join(" ")).not.toContain(
      "requires visible subject",
    );
  });

  it("treats crowd members as visible when the keyframe grounds the crowd", () => {
    const issues = validateSceneContinuity(
      plan([
        scene("scene_1", {
          image_prompt: "A stunned crowd gathers around Joseph in the alley.",
          continuity: {
            ...scene("base").continuity,
            required_subjects: ["crowd members"],
            opening_state: "The crowd gathers at the alley entrance.",
            closing_state: "The crowd surrounds Joseph in disbelief.",
            setting: "Detroit alley entrance.",
          },
        }),
      ]),
      { requireLedger: true },
    );

    expect(issues.join(" ")).not.toContain("requires visible subject");
  });

  it("does not treat a historical decade as part of a visible person's identity", () => {
    const issues = validateSceneContinuity(
      plan([
        scene("scene_1", {
          image_prompt: "Period pedestrians cross a wet Detroit street.",
          continuity: {
            ...scene("base").continuity,
            required_subjects: ["1930s pedestrians"],
            opening_state: "Pedestrians move through the same Detroit block.",
            closing_state: "The pedestrians continue along the wet sidewalk.",
            setting: "Detroit in the 1930s.",
          },
        }),
      ]),
      { requireLedger: true },
    );

    expect(issues.join(" ")).not.toContain("requires visible subject");
  });

  it("accepts a named person in narration for a generic man story subject", () => {
    const namedScene = scene("scene_1", {
      narration: "Joseph returns to work in the Detroit alley.",
      continuity: {
        ...scene("base").continuity,
        story_beat: "The man enters the alley and resumes sweeping.",
        required_subjects: ["Joseph"],
        opening_state: "Joseph enters the alley with his broom.",
        closing_state: "Joseph sweeps deeper into the alley.",
        setting: "Detroit alley.",
      },
    });

    expect(validateSceneContinuity(plan([namedScene]), { requireLedger: true }).join(" ")).not.toContain(
      "narration omits the active man",
    );
  });

  it("matches common setting and vehicle aliases without wasting a repair turn", () => {
    const issues = validateSceneContinuity(
      plan([
        scene("scene_1", {
          image_prompt: "A narrow brick alley with parked period cars along the street beyond.",
          continuity: {
            ...scene("base").continuity,
            required_subjects: ["alley setting", "period automobiles"],
            opening_state: "The alley opens onto a street with parked cars.",
            closing_state: "The same alley and parked cars remain visible.",
            setting: "A narrow brick alley in Detroit.",
          },
        }),
      ]),
      { requireLedger: true },
    );

    expect(issues.join(" ")).not.toContain("requires visible subject");
  });

  it("allows a clean cut between different tracked subjects and locations", () => {
    const first = scene("scene_1", {
      image_prompt: "John sits at his property-management office desk.",
      continuity: {
        ...scene("base").continuity,
        required_subjects: ["John"],
        opening_state: "John sits beside his office computer.",
        closing_state: "John sends an email from his office computer.",
        setting: "John's office in the afternoon.",
      },
    });
    const second = scene("scene_2", {
      image_prompt: "Sarah reads the email on her smartphone at home.",
      continuity: {
        ...scene("base").continuity,
        required_subjects: ["Sarah"],
        opening_state: "Sarah sits alone on her living-room sofa.",
        closing_state: "Sarah lowers her smartphone, disappointed.",
        setting: "Sarah's living room in the afternoon.",
      },
    });

    const issues = validateSceneContinuity(plan([first, second]), { requireLedger: true });

    expect(issues.join(" ")).not.toContain("does not inherit enough physical state");
  });

  it("rejects title cards and unexplained screen-direction reversals", () => {
    const issues = validateSceneContinuity(
      plan([
        scene("scene_1"),
        scene("scene_2", {
          image_prompt: "Black screen with large title text.",
          video_prompt: "The child keeps walking.",
          continuity: {
            ...scene("base").continuity,
            story_beat: "The child continues toward the adult.",
            screen_direction: "right_to_left",
          },
        }),
      ]),
      { requireLedger: true },
    );
    expect(issues.join(" ")).toContain("title/text/blank-screen");
    expect(issues.join(" ")).toContain("reverses a continuing subject");
  });

  it("rejects a causal beat whose narration omits its active subject", () => {
    const issues = validateSceneContinuity(
      plan([
        scene("scene_1", {
          narration: "Joseph swept the same street every day. Both walked away unharmed.",
          image_prompt: "Joseph holds a real baby girl safely after the catch.",
          video_prompt: "The camera tilts toward the open window.",
          continuity: {
            ...scene("base").continuity,
            story_beat: "A baby girl falls from a window and lands on Joseph.",
            required_subjects: ["baby girl", "Joseph"],
            opening_state: "A real baby girl is above Joseph.",
            closing_state: "Joseph holds the baby girl safely after the event.",
          },
        }),
      ]),
      { requireLedger: true },
    );

    expect(issues.join(" ")).toContain("narration omits the active baby");
  });

  it("accepts causal narration and motion that explicitly show the event", () => {
    const actionScene = scene("scene_1", {
      duration_seconds: 10,
      narration: "A baby girl falls from a window, and Joseph catches her safely.",
      image_prompt: "A real baby girl descends from an open fourth-story window toward Joseph's waiting arms below.",
      video_prompt: "The baby girl falls toward Joseph, who catches her in both arms.",
      continuity: {
        ...scene("base").continuity,
        story_beat: "A baby girl falls from a window and Joseph catches her.",
        required_subjects: ["baby girl", "Joseph"],
        opening_state: "A real baby girl is directly below the open window and vertically above Joseph's waiting arms.",
        closing_state: "Joseph catches the baby girl safely.",
      },
    });

    expect(validateSceneContinuity(plan([actionScene]), { requireLedger: true })).toEqual([]);
  });

  it("does not turn a hypothetical spoken hook into a repeated physical event", () => {
    const mismatch = scene("scene_1", {
      narration: "Imagine two babies falling from the sky onto the same man.",
      image_prompt: "Joseph sweeps a historical sidewalk below a brick tenement.",
      video_prompt: "The camera slowly pushes toward Joseph as he sweeps.",
      continuity: {
        ...scene("base").continuity,
        story_beat: "Joseph sweeps the sidewalk before anything unusual happens.",
        required_subjects: ["Joseph"],
        opening_state: "Joseph begins sweeping alone on the sidewalk.",
        closing_state: "Joseph continues sweeping alone on the sidewalk.",
      },
    });

    expect(causalOpeningKeyframeGuidance(mismatch)).toBe("");
    expect(causalGeometryGuidance(mismatch)).toBe("");
    expect(causalMotionInstruction(mismatch)).toBe(mismatch.video_prompt);
    expect(validateSceneContinuity(plan([mismatch]), { requireLedger: true })).toEqual([]);
  });

  it("accepts a child synonym or pronoun instead of requiring every redundant age label", () => {
    const actionScene = scene("scene_1", {
      duration_seconds: 10,
      narration: "The child falls from above, and Joseph catches him safely.",
      image_prompt: "A baby boy descends from a fire escape toward Joseph below.",
      video_prompt: "The baby boy descends and Joseph catches him.",
      continuity: {
        ...scene("base").continuity,
        story_beat: "A baby boy falls from the fire escape and lands in Joseph's arms.",
        required_subjects: ["baby boy", "Joseph"],
        opening_state: "The baby boy is airborne below the fire escape and above Joseph.",
        closing_state: "Joseph catches the baby boy safely below the fire escape.",
        setting: "A brick alley below a fire escape.",
      },
    });

    expect(validateSceneContinuity(plan([actionScene]), { requireLedger: true })).toEqual([]);
  });

  it("accepts geometry distributed across the compiled scene ledger", () => {
    const actionScene = scene("scene_1", {
      duration_seconds: 10,
      narration: "A baby girl falls from a window, and Joseph catches her safely.",
      image_prompt: "A real baby girl is airborne above Joseph as he looks up.",
      video_prompt: "Continue the physically connected action through the catch.",
      continuity: {
        ...scene("base").continuity,
        story_beat: "A baby girl falls from a window and Joseph catches her.",
        required_subjects: ["baby girl", "Joseph"],
        opening_state: "The baby girl descends from the open fourth-story window toward Joseph's waiting arms below.",
        closing_state: "Joseph catches the baby girl safely in both arms below the same window.",
        setting: "Detroit sidewalk beneath the fourth-story tenement window.",
      },
    });

    expect(validateSceneContinuity(plan([actionScene]), { requireLedger: true })).toEqual([]);
  });

  it("accepts fall geometry declared in the story beat and setting", () => {
    const actionScene = scene("scene_1", {
      duration_seconds: 10,
      narration: "The baby boy falls, and Joseph catches him.",
      image_prompt: "Joseph looks upward while a baby boy is airborne above him.",
      video_prompt: "Continue the downward motion into the safe catch.",
      continuity: {
        ...scene("base").continuity,
        story_beat: "A baby boy falls from the fire escape toward Joseph's shoulders below.",
        required_subjects: ["baby boy", "Joseph", "brick alley walls and fire escape"],
        opening_state: "Joseph looks up while the baby boy is airborne above him.",
        closing_state: "The baby boy lands safely across Joseph's shoulders.",
        setting: "Narrow brick alley with a fire escape directly above Joseph.",
      },
    });

    expect(validateSceneContinuity(plan([actionScene]), { requireLedger: true })).toEqual([]);
  });

  it("rejects falling action without an elevated origin and destination below", () => {
    const actionScene = scene("scene_1", {
      duration_seconds: 10,
      narration: "A baby girl falls, and Joseph catches her safely.",
      image_prompt: "Joseph reaches sideways as a baby girl moves through the air.",
      video_prompt: "The baby girl falls and Joseph catches her.",
      continuity: {
        ...scene("base").continuity,
        story_beat: "A baby girl falls and Joseph catches her.",
        required_subjects: ["baby girl", "Joseph"],
        opening_state: "The baby girl is moving through the air near Joseph.",
        closing_state: "Joseph catches the baby girl safely.",
      },
    });

    expect(validateSceneContinuity(plan([actionScene]), { requireLedger: true }).join(" ")).toContain(
      "compiled falling keyframe context lacks explicit physical geometry",
    );
  });

  it("rejects a short causal shot that cannot visibly complete its outcome", () => {
    const actionScene = scene("scene_1", {
      duration_seconds: 5,
      narration: "The child falls from the fire escape and Joseph catches him.",
      image_prompt: "Joseph waits below a fire escape with clear vertical space above.",
      video_prompt: "The child descends from the fire escape and lands safely across Joseph's shoulders.",
      continuity: {
        ...scene("base").continuity,
        story_beat: "A child falls from the fire escape toward Joseph below.",
        required_subjects: ["child", "Joseph", "fire escape"],
        opening_state: "Joseph waits directly below the fire escape and looks upward.",
        closing_state: "The child lands safely across Joseph's shoulders.",
        setting: "A brick alley below a fire escape.",
      },
    });

    expect(validateSceneContinuity(plan([actionScene]), { requireLedger: true }).join(" ")).toContain(
      "allocate at least 8s",
    );
  });

  it("removes camera reframing that can hide a required causal outcome", () => {
    const actionScene = scene("scene_1", {
      duration_seconds: 10,
      narration: "The child falls from the fire escape and Joseph catches him.",
      image_prompt: "Joseph waits below a fire escape with clear vertical space above.",
      video_prompt: "Whip pan upward as the child falls, then Joseph catches him.",
      continuity: {
        ...scene("base").continuity,
        story_beat: "A child falls from the fire escape toward Joseph below.",
        required_subjects: ["child", "Joseph", "fire escape"],
        opening_state: "Joseph waits directly below the fire escape and looks upward.",
        closing_state: "Joseph holds the child safely after the catch.",
        setting: "A brick alley below a fire escape.",
      },
    });

    expect(causalMotionInstruction(actionScene)).not.toMatch(/whip pan|camera/i);
    expect(causalMotionInstruction(actionScene)).toContain("Joseph catches him");
    expect(validateSceneContinuity(plan([actionScene]), { requireLedger: true })).toEqual([]);
  });

  it("rejects instructions for generated readable text inside a story frame", () => {
    const timeBridge = scene("scene_1", {
      image_prompt: "An alley with a faded flyer on the wall that reads 1939.",
    });

    expect(validateSceneContinuity(plan([timeBridge]), { requireLedger: true }).join(" ")).toContain(
      "render readable text",
    );
  });

  it("does not treat survival-after-the-falls wording as a new falling event", () => {
    const aftermath = scene("scene_1", {
      narration: "Both children survived, and the stunned crowd could barely believe it.",
      image_prompt: "Joseph stands safely among a stunned crowd in the same historical alley.",
      video_prompt: "The crowd leans closer while Joseph exhales.",
      continuity: {
        ...scene("base").continuity,
        story_beat: "The stunned crowd reacts after both children survived the falls.",
        required_subjects: ["Joseph", "crowd"],
        opening_state: "Joseph stands safely among the gathered crowd.",
        closing_state: "The crowd surrounds Joseph in disbelief.",
      },
    });

    expect(validateSceneContinuity(plan([aftermath]), { requireLedger: true }).join(" ")).not.toContain(
      "compiled falling keyframe context lacks explicit physical geometry",
    );
  });

  it("lets the provider compiler replace a completed falling image prompt with the effective opening state", () => {
    const actionScene = scene("scene_1", {
      narration: "A baby falls from the window, and Joseph catches her.",
      image_prompt: "Below an open fourth-story window, Joseph is already holding the baby safely in his arms.",
      video_prompt: "The baby falls from the window and Joseph catches her.",
      continuity: {
        ...scene("base").continuity,
        story_beat: "A baby falls from the fourth-story window and Joseph catches her.",
        required_subjects: ["baby", "Joseph"],
        opening_state: "The baby is airborne below the window and above Joseph.",
        closing_state: "Joseph holds the baby safely.",
      },
    });

    expect(validateSceneContinuity(plan([actionScene]), { requireLedger: true }).join(" ")).not.toContain(
      "starts after the falling/catching action is already complete",
    );
  });

  it("does not spend the agent repair turn on completed catch wording that the provider compiler replaces", () => {
    const actionScene = scene("scene_1", {
      narration: "A baby girl fell from above, and Joseph caught her.",
      image_prompt:
        "Joseph cradles a bundled baby girl in both arms below an open fourth-story window.",
      video_prompt: "Tilt from Joseph and the baby toward the window above.",
      continuity: {
        ...scene("base").continuity,
        story_beat: "A baby girl falls from the fourth-story window and Joseph catches her.",
        required_subjects: ["baby girl", "Joseph"],
        opening_state: "Joseph sweeps beneath the fourth-story window before the baby falls.",
        closing_state: "Joseph cradles the baby girl safely in both arms.",
        setting: "Detroit sidewalk below an open fourth-story window.",
      },
    });

    expect(validateSceneContinuity(plan([actionScene]), { requireLedger: true }).join(" ")).not.toContain(
      "starts after the falling/catching action is already complete",
    );
  });

  it("chains only immediate same-world continuations", () => {
    const first = scene("scene_1", {
      continuity: {
        ...scene("base").continuity,
        required_subjects: ["Joseph Figlock"],
        closing_state: "Joseph sweeps beneath the brick tenement window on the Detroit sidewalk.",
        setting: "Detroit sidewalk below the brick tenement, daytime.",
      },
    });
    const directContinuation = scene("scene_2", {
      continuity: {
        ...scene("base").continuity,
        required_subjects: ["Joseph Figlock", "baby girl"],
        opening_state: "Joseph remains beneath the same brick tenement window on the Detroit sidewalk.",
        setting: "Same Detroit sidewalk below the brick tenement, daytime.",
      },
    });
    const timeJump = scene("scene_3", {
      continuity: {
        ...scene("base").continuity,
        story_beat: "One year passes before Joseph cleans a different alley.",
        required_subjects: ["Joseph Figlock"],
        opening_state: "Joseph starts work in a narrow alley in autumn.",
        setting: "Narrow Detroit alley after one year has passed.",
      },
    });
    const testPlan = plan([first, directContinuation, timeJump]);

    expect(shouldChainPreviousKeyframe(testPlan, 1)).toBe(true);
    expect(shouldChainPreviousKeyframe(testPlan, 2)).toBe(false);
    expect(validateSceneContinuity(testPlan, { requireLedger: true }).join(" ")).not.toContain(
      "opening state does not inherit enough physical state",
    );
  });

  it("allows a time-bridge scene to hand off into the next established location", () => {
    const bridge = scene("scene_1", {
      continuity: {
        ...scene("base").continuity,
        story_beat: "One year passes as Detroit streets carry the story into a different neighborhood.",
        required_subjects: ["Joseph"],
        opening_state: "Joseph leaves the original tenement sidewalk.",
        closing_state: "One year later, Joseph reaches a narrow Detroit alley.",
        setting: "Detroit streets during an explicit one-year passage.",
      },
    });
    const alleyEvent = scene("scene_2", {
      continuity: {
        ...scene("base").continuity,
        story_beat: "Joseph begins cleaning inside the narrow alley.",
        required_subjects: ["Joseph"],
        opening_state: "Joseph stands in the narrow Detroit alley with his broom.",
        closing_state: "Joseph continues sweeping beneath the alley fire escape.",
        setting: "Narrow Detroit alley one year later.",
      },
    });

    expect(validateSceneContinuity(plan([bridge, alleyEvent]), { requireLedger: true })).toEqual([]);
  });

  it("does not mistake elapsed time for a physical handoff", () => {
    const timeBridge = scene("scene_1", {
      narration: "One year passed as Joseph returned to work in a different Detroit alley.",
      image_prompt: "Joseph walks into a different Detroit alley one year later.",
      video_prompt: "Joseph walks steadily into the alley while the camera tracks beside him.",
      continuity: {
        ...scene("base").continuity,
        story_beat: "One year passes and Joseph enters a different Detroit alley.",
        required_subjects: ["Joseph"],
        opening_state: "Joseph approaches the entrance of a different Detroit alley one year later.",
        closing_state: "Joseph stands inside that alley with his broom.",
        setting: "A different Detroit alley one year later.",
      },
    });

    expect(validateSceneContinuity(plan([timeBridge]), { requireLedger: true }).join(" ")).not.toContain(
      "handoff/transfer",
    );
  });

  it("accepts an explosion as visible motion for a projectile impact beat", () => {
    const actionScene = scene("scene_1", {
      narration: "",
      image_prompt: "Two aircraft above a soldier and tank on the same battlefield.",
      video_prompt: "The missile strikes the lead aircraft and both aircraft explode in the sky.",
      continuity: {
        ...scene("base").continuity,
        story_beat: "The missile hits the lead aircraft in the final payoff.",
        required_subjects: ["aircraft", "soldier", "tank"],
        opening_state: "Two aircraft fly above the soldier and tank.",
        closing_state: "Both aircraft explode above the soldier and tank.",
      },
    });

    expect(validateSceneContinuity(plan([actionScene]), { requireLedger: true })).toEqual([]);
  });

  it("rejects an unexplained character appearing only in the closing state", () => {
    const issues = validateSceneContinuity(
      plan([
        scene("scene_1", {
          narration: "Joseph and the baby boy survived.",
          image_prompt: "Joseph holds a baby boy while a slightly older girl stands beside him.",
          video_prompt: "Joseph looks from the baby boy to the girl beside him.",
          continuity: {
            ...scene("base").continuity,
            story_beat: "Joseph holds the baby boy while the older girl stands beside them.",
            required_subjects: ["Joseph Figlock", "baby boy", "baby girl in dark dress"],
            opening_state: "Joseph has just caught the baby boy in an empty alley.",
            closing_state: "Joseph holds the baby boy while the baby girl stands beside him.",
          },
        }),
      ]),
      { requireLedger: true },
    );

    expect(issues.join(" ")).toContain("without showing an arrival or entrance");
  });

  it("rejects hidden state changes described as happening between scenes", () => {
    const issues = validateSceneContinuity(
      plan([
        scene("scene_1", {
          continuity: {
            ...scene("base").continuity,
            opening_state: "The baby has been handed off between scenes and the adult is now alone.",
          },
        }),
      ]),
      { requireLedger: true },
    );

    expect(issues.join(" ")).toContain("hides a character/object movement between scenes");
  });
});
