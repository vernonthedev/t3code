import { createFileRoute } from "@tanstack/react-router";

import { SkillsSettingsPanel } from "../components/settings/SkillsSettings";

function SettingsSkillsRoute() {
  return <SkillsSettingsPanel />;
}

export const Route = createFileRoute("/settings/skills")({
  component: SettingsSkillsRoute,
});
