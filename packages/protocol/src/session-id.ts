import { z } from "zod";

export const SidSchema = z.string().min(1).max(128);
