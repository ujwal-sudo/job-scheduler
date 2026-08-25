import request from 'supertest';
import { getApp, registerAndLogin } from './helpers';

describe('Auth', () => {
  it('registers a user and returns tokens', async () => {
    const email = `auth-${Date.now()}@test.dev`;
    const res = await request(getApp())
      .post('/api/v1/auth/register')
      .send({ email, password: 'password123', name: 'Auth Test' });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.accessToken).toBeTruthy();
    expect(res.body.data.refreshToken).toBeTruthy();
    expect(res.body.data.user.email).toBe(email);
  });

  it('rejects duplicate registration', async () => {
    const app = getApp();
    const body = { email: `dup-${Date.now()}@test.dev`, password: 'password123', name: 'Dup' };
    await request(app).post('/api/v1/auth/register').send(body);
    const res = await request(app).post('/api/v1/auth/register').send(body);
    expect(res.status).toBe(409);
    expect(res.body.success).toBe(false);
  });

  it('logs in with valid credentials', async () => {
    const { token } = await registerAndLogin();
    expect(token).toBeTruthy();
  });

  it('rejects invalid credentials', async () => {
    await registerAndLogin();
    const res = await request(getApp())
      .post('/api/v1/auth/login')
      .send({ email: 'nobody@test.dev', password: 'wrongpass' });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('refreshes tokens via refresh token rotation', async () => {
    const app = getApp();
    const reg = await request(app)
      .post('/api/v1/auth/register')
      .send({ email: `refresh-${Date.now()}@test.dev`, password: 'password123', name: 'R' });
    const refreshToken = reg.body.data.refreshToken;

    const res = await request(app).post('/api/v1/auth/refresh').send({ refreshToken });
    expect(res.status).toBe(200);
    expect(res.body.data.accessToken).toBeTruthy();

    // A garbage refresh token is rejected
    const bad = await request(app).post('/api/v1/auth/refresh').send({ refreshToken: 'garbage.token.here' });
    expect(bad.status).toBe(401);
  });

  it('GET /me requires auth and returns the user', async () => {
    const app = getApp();
    const noAuth = await request(app).get('/api/v1/auth/me');
    expect(noAuth.status).toBe(401);

    const { token } = await registerAndLogin();
    const res = await request(app).get('/api/v1/auth/me').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.id).toBeTruthy();
  });
});
