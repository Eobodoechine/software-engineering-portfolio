import nodemailer from 'nodemailer';
import { jobLog } from './jobLogger';

// Email configuration
const NOTIFICATION_EMAIL = process.env.NOTIFICATION_EMAIL || 'operator@example.invalid';

// Use Gmail SMTP or environment variables for custom SMTP
const EMAIL_USER = process.env.EMAIL_USER || '';
const EMAIL_PASS = process.env.EMAIL_PASS || '';
const EMAIL_FROM = process.env.EMAIL_FROM || 'PropertyVision Alerts <alerts@propertyvision.app>';

// App URL for email links (environment-aware)
const APP_URL = process.env.NEXT_PUBLIC_APP_URL || process.env.APP_URL || 'http://localhost:3000';

// Create reusable transporter
let transporter: nodemailer.Transporter | null = null;

function getTransporter() {
  if (!transporter && EMAIL_USER && EMAIL_PASS) {
    transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: EMAIL_USER,
        pass: EMAIL_PASS
      }
    });
  }
  return transporter;
}

interface ErrorNotificationParams {
  jobId: string;
  address: string;
  error: string;
  phase?: string;
  attempts?: number;
  timestamp?: number;
  userId?: string;
}

export async function sendErrorNotification(params: ErrorNotificationParams): Promise<boolean> {
  if (process.env.PV_LOCAL_DEMO === 'true') return false;
  const { jobId, address, error, phase, attempts, timestamp, userId } = params;

  // Skip if email not configured
  const transport = getTransporter();
  if (!transport) {
    jobLog('⚠️  Email not configured, skipping error notification');
    return false;
  }

  const date = timestamp ? new Date(timestamp).toLocaleString() : new Date().toLocaleString();

  const mailOptions = {
    from: EMAIL_FROM,
    to: NOTIFICATION_EMAIL,
    subject: `PropertyVision Error: ${address}`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #dc2626;">❌ PropertyVision Analysis Error</h2>

        <div style="background-color: #fee; border-left: 4px solid #dc2626; padding: 15px; margin: 20px 0;">
          <p style="margin: 0;"><strong>Address:</strong> ${address}</p>
        </div>

        <table style="width: 100%; border-collapse: collapse; margin: 20px 0;">
          <tr style="background-color: #f9fafb;">
            <td style="padding: 10px; border: 1px solid #e5e7eb;"><strong>Job ID</strong></td>
            <td style="padding: 10px; border: 1px solid #e5e7eb;">${jobId}</td>
          </tr>
          ${userId ? `
          <tr>
            <td style="padding: 10px; border: 1px solid #e5e7eb;"><strong>User ID</strong></td>
            <td style="padding: 10px; border: 1px solid #e5e7eb;">${userId}</td>
          </tr>
          ` : ''}
          <tr${userId ? '' : ' style="background-color: #f9fafb;"'}>
            <td style="padding: 10px; border: 1px solid #e5e7eb;"><strong>Error Time</strong></td>
            <td style="padding: 10px; border: 1px solid #e5e7eb;">${date}</td>
          </tr>
          ${phase ? `
          <tr style="background-color: #f9fafb;">
            <td style="padding: 10px; border: 1px solid #e5e7eb;"><strong>Phase</strong></td>
            <td style="padding: 10px; border: 1px solid #e5e7eb;">${phase}</td>
          </tr>
          ` : ''}
          ${attempts ? `
          <tr>
            <td style="padding: 10px; border: 1px solid #e5e7eb;"><strong>Attempts</strong></td>
            <td style="padding: 10px; border: 1px solid #e5e7eb;">${attempts}</td>
          </tr>
          ` : ''}
        </table>

        <div style="background-color: #fef2f2; border: 1px solid #fecaca; padding: 15px; margin: 20px 0; border-radius: 4px;">
          <h3 style="color: #991b1b; margin-top: 0;">Error Details:</h3>
          <pre style="background-color: #fff; padding: 10px; border-radius: 4px; overflow-x: auto; font-size: 12px;">${error}</pre>
        </div>

        <div style="margin-top: 30px; padding-top: 20px; border-top: 1px solid #e5e7eb; color: #6b7280; font-size: 12px;">
          <p>View logs: <a href="https://console.cloud.google.com/logs/query?project=your-google-cloud-project" style="color: #2563eb;">Cloud Console</a></p>
          <p>This is an automated notification from PropertyVision.</p>
        </div>
      </div>
    `
  };

  try {
    await transport.sendMail(mailOptions);
    jobLog(`📧 Error notification sent to ${NOTIFICATION_EMAIL} for address: ${address}`);
    return true;
  } catch (emailError: any) {
    console.error('❌ Failed to send error notification email:', emailError.message);
    return false;
  }
}

interface SuccessNotificationParams {
  jobId: string;
  address: string;
  arv?: number;
  compsCount?: number;
  duration?: number;
  timestamp?: number;
  userId?: string;
}

export async function sendSuccessNotification(params: SuccessNotificationParams): Promise<boolean> {
  if (process.env.PV_LOCAL_DEMO === 'true') return false;
  const { jobId, address, arv, compsCount, duration, timestamp, userId } = params;

  // Skip if email not configured
  const transport = getTransporter();
  if (!transport) {
    jobLog('⚠️  Email not configured, skipping success notification');
    return false;
  }

  const date = timestamp ? new Date(timestamp).toLocaleString() : new Date().toLocaleString();
  const durationText = duration ? `${Math.round(duration / 1000)}s` : 'N/A';

  const mailOptions = {
    from: EMAIL_FROM,
    to: NOTIFICATION_EMAIL,
    subject: `✅ PropertyVision Analysis Complete: ${address}`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #059669;">✅ PropertyVision Analysis Complete</h2>

        <div style="background-color: #d1fae5; border-left: 4px solid #059669; padding: 15px; margin: 20px 0;">
          <p style="margin: 0;"><strong>Address:</strong> ${address}</p>
        </div>

        <table style="width: 100%; border-collapse: collapse; margin: 20px 0;">
          <tr style="background-color: #f9fafb;">
            <td style="padding: 10px; border: 1px solid #e5e7eb;"><strong>Job ID</strong></td>
            <td style="padding: 10px; border: 1px solid #e5e7eb;">${jobId}</td>
          </tr>
          ${userId ? `
          <tr>
            <td style="padding: 10px; border: 1px solid #e5e7eb;"><strong>User ID</strong></td>
            <td style="padding: 10px; border: 1px solid #e5e7eb;">${userId}</td>
          </tr>
          ` : ''}
          <tr${userId ? '' : ' style="background-color: #f9fafb;"'}>
            <td style="padding: 10px; border: 1px solid #e5e7eb;"><strong>Completed At</strong></td>
            <td style="padding: 10px; border: 1px solid #e5e7eb;">${date}</td>
          </tr>
          <tr style="background-color: #f9fafb;">
            <td style="padding: 10px; border: 1px solid #e5e7eb;"><strong>Duration</strong></td>
            <td style="padding: 10px; border: 1px solid #e5e7eb;">${durationText}</td>
          </tr>
          ${arv ? `
          <tr>
            <td style="padding: 10px; border: 1px solid #e5e7eb;"><strong>ARV</strong></td>
            <td style="padding: 10px; border: 1px solid #e5e7eb;">$${arv.toLocaleString()}</td>
          </tr>
          ` : `
          <tr>
            <td style="padding: 10px; border: 1px solid #e5e7eb;"><strong>ARV</strong></td>
            <td style="padding: 10px; border: 1px solid #e5e7eb; color: #dc2626;">⚠️ ARV Unavailable</td>
          </tr>
          `}
          ${compsCount ? `
          <tr style="background-color: #f9fafb;">
            <td style="padding: 10px; border: 1px solid #e5e7eb;"><strong>Comparables Found</strong></td>
            <td style="padding: 10px; border: 1px solid #e5e7eb;">${compsCount}</td>
          </tr>
          ` : ''}
        </table>

        <div style="margin-top: 30px; padding-top: 20px; border-top: 1px solid #e5e7eb; color: #6b7280; font-size: 12px;">
          <p>View results: <a href="${APP_URL}" style="color: #2563eb;">PropertyVision Dashboard</a></p>
          <p>This is an automated notification from PropertyVision.</p>
        </div>
      </div>
    `
  };

  try {
    await transport.sendMail(mailOptions);
    jobLog(`📧 Success notification sent to ${NOTIFICATION_EMAIL} for address: ${address}`);
    return true;
  } catch (emailError: any) {
    console.error('❌ Failed to send success notification email:', emailError.message);
    return false;
  }
}
