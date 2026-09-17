import { z } from "zod";
export const taskStatusSchema = z.enum(["pending", "in-progress", "done"]);
export type TaskStatus = z.infer<typeof taskStatusSchema>;
