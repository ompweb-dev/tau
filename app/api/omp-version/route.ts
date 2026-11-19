import { getPiVersion } from "@/lib/pi/pi-cli";

/** Runtime probe of the installed omp binary ("omp/17.1.3"), separate from the
 * build-time tau version — the two can legitimately drift. */
export async function GET() {
  const version = await getPiVersion();
  return Response.json({ version });
}
