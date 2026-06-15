import { createFileRoute } from "@tanstack/react-router";

import { CreateSkillSettingsPanel } from "../components/settings/SkillsSettings";

function SettingsSkillsCreateRoute() {
  return <CreateSkillSettingsPanel />;
}

export const Route = createFileRoute("/settings/skills/create")({
  component: SettingsSkillsCreateRoute,
});
