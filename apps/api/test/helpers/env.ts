// Runs before every e2e test file (and before any app module is imported).
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgresql://ros:ros_dev_password@localhost:5432/restaurant_os_test?schema=public';
process.env.JWT_ACCESS_SECRET ??= 'test-access-secret-0123456789abcdef0123456789';
process.env.MAIL_TRANSPORT = 'memory';
process.env.LOG_LEVEL = 'silent';
process.env.AUTH_RATE_LIMIT_PER_MINUTE = '100000';
process.env.RATE_LIMIT_PER_MINUTE = '100000';
process.env.CORS_ORIGINS = 'http://localhost:3000';
process.env.SWAGGER_ENABLED = 'false';
