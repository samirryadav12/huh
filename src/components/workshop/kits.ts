import type { WorkshopKit } from "./kit";
import { DRONE_KIT } from "./droneKit";
import { ARM_KIT } from "./armKit";
import { SOCCER_KIT } from "./soccerKit";

/* Projects (on the shared project page) that have a 3D workshop. The Line Follower has its own page. */
const KITS: Record<string, WorkshopKit> = { "drone-explorer": DRONE_KIT, "robotic-arm": ARM_KIT, robosoccer: SOCCER_KIT };
export const kitForSlug = (slug: string): WorkshopKit | null => KITS[slug] ?? null;
