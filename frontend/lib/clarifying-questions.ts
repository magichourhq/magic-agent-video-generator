import type { WorkflowMode } from "./types";

export type ClarifyingQuestionId = "goal" | "tone" | "visual_direction" | "source_strategy";

export type ClarifyingOption = {
  id: string;
  label: string;
  summary: string;
  value: string;
};

export type ClarifyingQuestion = {
  id: ClarifyingQuestionId;
  label: string;
  question: string;
  helper: string;
  options: ClarifyingOption[];
};

export type ClarifyingAnswer = {
  questionId: ClarifyingQuestionId;
  label: string;
  value: string;
};

const SHARED_QUESTIONS: ClarifyingQuestion[] = [
  {
    id: "goal",
    label: "Primary outcome",
    question: "What should this video optimize for?",
    helper: "Pick the job this short should do before I plan scenes.",
    options: [
      {
        id: "hook",
        label: "Hook attention",
        summary: "Lead with surprise and retention.",
        value: "Hook attention in the first seconds and hold retention.",
      },
      {
        id: "explain",
        label: "Explain clearly",
        summary: "Make the idea easy to understand.",
        value: "Explain the concept clearly with a simple narrative arc.",
      },
      {
        id: "sell",
        label: "Drive action",
        summary: "Push toward a click, signup, or purchase.",
        value: "Drive a concrete viewer action by the end.",
      },
    ],
  },
  {
    id: "tone",
    label: "Tone and pacing",
    question: "What tone should I steer toward?",
    helper: "This changes the voiceover, shot rhythm, and edit density.",
    options: [
      {
        id: "cinematic",
        label: "Cinematic",
        summary: "Polished, dramatic, controlled.",
        value: "Cinematic, polished, and emotionally controlled.",
      },
      {
        id: "social",
        label: "Fast social",
        summary: "Punchy, direct, high-energy.",
        value: "Fast social pacing with punchy, direct beats.",
      },
      {
        id: "documentary",
        label: "Documentary",
        summary: "Grounded and observational.",
        value: "Grounded documentary tone with believable details.",
      },
    ],
  },
];

const GENERATED_QUESTION: ClarifyingQuestion = {
  id: "visual_direction",
  label: "Visual direction",
  question: "How much visual invention should I use?",
  helper: "This guides generated images, animation prompts, and continuity.",
  options: [
    {
      id: "agent-decides",
      label: "Agent decides",
      summary: "Let the agent fill in style and shots.",
      value: "Let the agent choose the visual style and shot design.",
    },
    {
      id: "grounded",
      label: "Keep it grounded",
      summary: "Physical, believable, less surreal.",
      value: "Keep the visuals physically grounded and believable.",
    },
    {
      id: "stylized",
      label: "Go stylized",
      summary: "Bolder world, lighting, and motion.",
      value: "Use stylized visuals with bold lighting, motion, and worldbuilding.",
    },
  ],
};

const YOUTUBE_QUESTION: ClarifyingQuestion = {
  id: "source_strategy",
  label: "Source clip strategy",
  question: "What kind of source clips should I prioritize?",
  helper: "This guides search hints and the type of clips the agent tries to collect.",
  options: [
    {
      id: "recent",
      label: "Recent coverage",
      summary: "News, interviews, timely clips.",
      value: "Prioritize recent coverage, interviews, and timely clips.",
    },
    {
      id: "evergreen",
      label: "Evergreen b-roll",
      summary: "Reusable explainers and clean visuals.",
      value: "Prioritize evergreen b-roll and reusable explanatory footage.",
    },
    {
      id: "high-motion",
      label: "High-motion clips",
      summary: "Action, highlights, intense footage.",
      value: "Prioritize high-motion clips, highlights, and visually intense footage.",
    },
  ],
};

export function buildClarifyingQuestions(workflow: WorkflowMode): ClarifyingQuestion[] {
  return [...SHARED_QUESTIONS, workflow === "youtube_clips" ? YOUTUBE_QUESTION : GENERATED_QUESTION];
}

export function composeClarifiedPrompt(
  basePrompt: string,
  questions: ClarifyingQuestion[],
  answers: ClarifyingAnswer[],
): string {
  const cleanedPrompt = basePrompt.trim();
  const lines = answers
    .map((answer) => {
      const question = questions.find((item) => item.id === answer.questionId);
      if (!question) return null;
      return `- ${question.label}: ${answer.value}`;
    })
    .filter((line): line is string => Boolean(line));

  if (lines.length === 0) return cleanedPrompt;

  return `${cleanedPrompt}\n\nClarifying answers:\n${lines.join("\n")}`;
}
