import { auth } from '../lib/auth';
import { Elysia } from 'elysia';

export const authMiddleware = new Elysia().derive(async ({ request, set }) => {
  const session = await auth.api.getSession({
    headers: request.headers,
  });

  if (!session) {
    set.status = 401;
    throw new Error('Unauthorized');
  }

  return {
    user: session.user,
    session: session.session,
  };
});
