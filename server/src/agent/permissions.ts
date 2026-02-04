import type { AgentId } from "@ai-shogun/shared";

type AgentRole = "shogun" | "karou" | "ashigaru";

export const buildAllowedRecipients = (options: {
  agentId: AgentId;
  role: AgentRole;
  ashigaruIds: AgentId[];
}) => {
  const allowedRecipients = new Set<string>();

  if (options.role === "shogun") {
    allowedRecipients.add("king");
    allowedRecipients.add("karou");
  }

  if (options.role === "karou") {
    allowedRecipients.add("shogun");
    for (const id of options.ashigaruIds) {
      allowedRecipients.add(id);
    }
  }

  if (options.role === "ashigaru") {
    allowedRecipients.add("karou");
    for (const id of options.ashigaruIds) {
      if (id !== options.agentId) allowedRecipients.add(id);
    }
  }

  return allowedRecipients;
};
