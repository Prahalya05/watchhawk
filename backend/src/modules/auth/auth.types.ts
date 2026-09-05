export interface JwtPayload {
  userId: string;
  email: string;
}

declare global {
  namespace Express {
    interface Request {
      auth?: JwtPayload;
    }
  }
}
