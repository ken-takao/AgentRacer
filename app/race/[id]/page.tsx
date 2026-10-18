import { SpectatorScreen } from "../../race-ui";
export default async function RacePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <SpectatorScreen id={id} />;
}
