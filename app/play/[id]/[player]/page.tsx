import { DriverScreen } from "../../../race-ui";
import { notFound } from "next/navigation";
export default async function PlayerPage({ params }: { params: Promise<{ id: string; player: string }> }) {
  const { id, player } = await params;
  if (player !== "red" && player !== "blue") notFound();
  return <DriverScreen id={id} player={player} />;
}
