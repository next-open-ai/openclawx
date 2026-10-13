import { z } from 'zod';

/** UTF-16 start offset in the corresponding Run transcript/reasoning string. */
export const RunTextDeltaPositionSchema = z.object({ textOffset: z.number().int().nonnegative().optional() });
export type RunTextDeltaPosition = z.infer<typeof RunTextDeltaPositionSchema>;
