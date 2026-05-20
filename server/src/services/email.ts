import { Resend } from 'resend';

const FROM_EMAIL = 'ARIA <noreply@ariatrust.org>';

console.log('[email] RESEND_API_KEY exists:', !!process.env.RESEND_API_KEY);
console.log('[email] APP_URL:', process.env.APP_URL);

// Lazy init — only construct when RESEND_API_KEY is present to avoid
// crashing at startup in local/dev environments.
function getResend(): Resend {
  const key = process.env.RESEND_API_KEY;
  if (!key) throw new Error('RESEND_API_KEY environment variable is not set');
  return new Resend(key);
}

export async function sendConfirmationEmail(
  email: string,
  name: string,
  token: string
): Promise<void> {
  const confirmUrl = `${process.env.APP_URL}/v1/auth/confirm?token=${token}`;

  const response = await getResend().emails.send({
    from: FROM_EMAIL,
    to: email,
    subject: 'Confirm your ARIA account',
    html: `
      <div style="font-family:system-ui;max-width:480px;margin:0 auto;padding:32px">
        <h1 style="font-size:24px;font-weight:700;margin-bottom:8px">Welcome to ARIA</h1>
        <p style="color:#666;margin-bottom:24px">Hi ${name}, confirm your email to get started.</p>
        <a href="${confirmUrl}"
           style="display:inline-block;background:#0a0a0a;color:#fff;
                  padding:12px 24px;border-radius:4px;text-decoration:none;
                  font-weight:500">
          Confirm Email
        </a>
        <p style="color:#999;font-size:12px;margin-top:24px">
          This link expires in 24 hours. If you did not create an ARIA account, ignore this email.
        </p>
      </div>
    `
  });
  console.log('[email] Resend response:', JSON.stringify(response));
}

export async function sendVerificationCode(
  email: string,
  code: string
): Promise<void> {
  const response = await getResend().emails.send({
    from: FROM_EMAIL,
    to: email,
    subject: `Your ARIA verification code: ${code}`,
    html: `
      <div style="font-family:system-ui;max-width:480px;margin:0 auto;padding:32px">
        <h1 style="font-size:24px;font-weight:700;margin-bottom:8px">Verification Code</h1>
        <p style="color:#666;margin-bottom:24px">Use this code to sign in to ARIA:</p>
        <div style="font-size:40px;font-weight:700;letter-spacing:8px;
                    text-align:center;padding:24px;background:#f5f5f5;
                    border-radius:8px;margin-bottom:24px">
          ${code}
        </div>
        <p style="color:#999;font-size:12px">
          This code expires in 10 minutes. Do not share it with anyone.
        </p>
      </div>
    `
  });
  console.log('[email] Resend response:', JSON.stringify(response));
}

export async function sendPasswordResetEmail(
  to: string,
  resetUrl: string
): Promise<void> {
  if (!process.env.RESEND_API_KEY) {
    console.log(`[email] Password reset link for ${to}: ${resetUrl}`);
    return;
  }

  await getResend().emails.send({
    from: FROM_EMAIL,
    to,
    subject: 'Reset your ARIA password',
    html: `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    body {
      font-family: 'IBM Plex Mono', monospace, sans-serif;
      background: #030507;
      color: #f0ece4;
      margin: 0;
      padding: 40px 20px;
    }
    .container {
      max-width: 480px;
      margin: 0 auto;
      background: #070b10;
      border: 1px solid rgba(212,168,67,0.2);
      border-top: 3px solid #d4a843;
      border-radius: 8px;
      padding: 40px;
    }
    .logo {
      font-size: 24px;
      font-weight: 700;
      color: #d4a843;
      letter-spacing: 4px;
      margin-bottom: 32px;
    }
    h1 { font-size: 18px; color: #f0ece4; margin-bottom: 16px; }
    p { color: rgba(240,236,228,0.65); line-height: 1.6; margin-bottom: 24px; font-size: 14px; }
    .button {
      display: inline-block;
      padding: 14px 28px;
      background: #d4a843;
      color: #030507;
      text-decoration: none;
      border-radius: 4px;
      font-weight: 600;
      font-size: 14px;
      margin-bottom: 24px;
    }
    .url { font-size: 11px; color: rgba(240,236,228,0.35); word-break: break-all; margin-bottom: 24px; }
    .footer {
      font-size: 11px;
      color: rgba(240,236,228,0.3);
      border-top: 1px solid rgba(255,255,255,0.06);
      padding-top: 20px;
      margin-top: 8px;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="logo">ARIA</div>
    <h1>Reset your password</h1>
    <p>
      You requested a password reset for your ARIA account.
      Click the button below to set a new password.
      This link expires in 1 hour.
    </p>
    <a href="${resetUrl}" class="button">Reset Password</a>
    <p class="url">Or copy this link:<br>${resetUrl}</p>
    <p>
      If you did not request this reset, you can safely ignore this email.
      Your password will not change.
    </p>
    <div class="footer">
      ARIA · ariatrust.org<br>
      This is an automated message — do not reply.
    </div>
  </div>
</body>
</html>
    `
  });
}

export async function sendGateRequestEmail(
  ownerEmail: string,
  agentName: string,
  action: string,
  requestId: string,
  timeoutMinutes: number
): Promise<void> {
  // Email notifications disabled - using dashboard
  // toast notifications instead
  console.log(
    `[gate] Notification suppressed for ${ownerEmail}: ` +
    `${agentName} → ${action} (${requestId})`
  );
  return;
}
