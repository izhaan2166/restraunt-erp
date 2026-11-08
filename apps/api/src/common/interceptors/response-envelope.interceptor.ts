import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable, map } from 'rxjs';
import { Paginated, WithMeta } from '../dto/pagination';

/** Wraps every successful response as `{ data }` or `{ data, meta }` for paginated results. */
@Injectable()
export class ResponseEnvelopeInterceptor implements NestInterceptor {
  intercept(_ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(
      map((value: unknown) => {
        if (value instanceof Paginated) return { data: value.items, meta: value.meta };
        if (value instanceof WithMeta) return { data: value.data, meta: value.meta };
        if (value === undefined) return undefined;
        return { data: value };
      }),
    );
  }
}
