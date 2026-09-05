import type { NextFunction, Request, RequestHandler, Response } from "express";

// Express 4 does not await route handlers, so a rejected promise inside an `async` one
// never reaches the error middleware in app.ts: the response is never sent, the request
// hangs until the client gives up, and the process logs an unhandled rejection (fatal by
// default on Node 20+). Every async handler goes through this, so a DB outage or an
// unexpected throw becomes a real 500 the client can act on instead of a dead socket.
export function asyncHandler(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    handler(req, res, next).catch(next);
  };
}
