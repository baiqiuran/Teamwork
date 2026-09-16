import type { PipeTransform } from "@nestjs/common";
import type { z } from "zod";

export class ZodPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: z.ZodType<T>) {}
  transform(value: unknown): T {
    return this.schema.parse(value);
  }
}
