import nodemailer from 'nodemailer';
import fs from 'fs';
import path from 'path';

export interface EmailPayload {
  type: 'report_ready' | 'weekly_report' | 'alert_no_clicks';
  recipient_email: string;
  subject: string;
  template_data: {
    user_name?: string;
    link_code?: string;
    campaign_name?: string;
    download_url?: string;
    period_start?: string;
    period_end?: string;
    file_path?: string;
  };
}

// SMTP config from environment variables
const smtpHost = process.env.SMTP_HOST || 'localhost';
const smtpPort = parseInt(process.env.SMTP_PORT || '1025', 10);
const smtpUser = process.env.SMTP_USER || '';
const smtpPass = process.env.SMTP_PASS || '';
const smtpFrom = process.env.SMTP_FROM || 'TrackFlow <noreply@trackflow.io>';

// Create Nodemailer Transporter (uses in-memory jsonTransport for fast, robust, offline integration testing)
export const transporter = (process.env.NODE_ENV === 'test' || process.env.VITEST === 'true')
  ? nodemailer.createTransport({
      jsonTransport: true
    })
  : nodemailer.createTransport({
      host: smtpHost,
      port: smtpPort,
      secure: smtpPort === 465,
      auth: smtpUser || smtpPass ? {
        user: smtpUser,
        pass: smtpPass
      } : undefined
    });

/**
 * Builds standard wrapping envelope for dark-theme premium emails
 */
function buildHtmlEnvelope(contentHtml: string): string {
  return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <title>TrackFlow Notification</title>
    </head>
    <body style="background-color: #0b0f19; padding: 40px 20px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #f8fafc; margin: 0;">
      <div style="max-width: 580px; margin: 0 auto; background-color: #151c2c; border: 1px solid #1e293b; border-radius: 16px; padding: 40px; box-shadow: 0 10px 15px -3px rgba(0, 0, 0, 0.5);">
        <div style="margin-bottom: 30px; border-bottom: 1px solid #1e293b; padding-bottom: 20px;">
          <span style="font-size: 24px; font-weight: 700; color: #a855f7;">TrackFlow</span>
          <div style="font-size: 10px; color: #94a3b8; text-transform: uppercase; letter-spacing: 1.5px; margin-top: 5px;">Link Shortening & Performance Analytics</div>
        </div>
        
        ${contentHtml}
        
        <div style="margin-top: 40px; border-top: 1px solid #1e293b; padding-top: 20px; text-align: center; font-size: 11px; color: #94a3b8; line-height: 1.5;">
          <p>This is an automated campaign notification from your TrackFlow dashboard.</p>
          <p style="margin-top: 5px;">&copy; 2026 TrackFlow Inc. All rights reserved.</p>
        </div>
      </div>
    </body>
    </html>
  `;
}

/**
 * Compiles specific email templates based on type
 */
function compileTemplate(payload: EmailPayload): string {
  const { type, template_data } = payload;
  const userName = template_data.user_name || 'Customer';
  const downloadUrl = template_data.download_url || '#';
  const periodStart = template_data.period_start || '';
  const periodEnd = template_data.period_end || '';
  const linkCode = template_data.link_code || '';
  const campaignName = template_data.campaign_name || 'Unnamed Campaign';

  let contentHtml = '';

  if (type === 'report_ready' || type === 'weekly_report') {
    contentHtml = `
      <h2 style="font-size: 18px; font-weight: 600; color: #f8fafc; margin-bottom: 16px;">Your Analytics Report is Ready!</h2>
      <p style="font-size: 14px; color: #94a3b8; line-height: 1.6; margin-bottom: 24px;">
        Hello <strong>${userName}</strong>,<br><br>
        Your campaign analytics report covering <strong>${periodStart} to ${periodEnd}</strong> has been successfully generated. A high-fidelity PDF breakdown has been attached to this email.
      </p>
      
      <div style="text-align: center; margin: 35px 0;">
        <a href="${downloadUrl}" style="background-color: #6366f1; color: #ffffff; text-decoration: none; padding: 12px 24px; border-radius: 8px; font-weight: 600; font-size: 14px; display: inline-block; box-shadow: 0 4px 6px -1px rgba(99, 102, 241, 0.4);">
          Download Report PDF
        </a>
      </div>
      
      <p style="font-size: 13px; color: #94a3b8; line-height: 1.6;">
        If the download button does not work, copy and paste this URL into your browser:<br>
        <a href="${downloadUrl}" style="color: #6366f1; word-break: break-all;">${downloadUrl}</a>
      </p>
    `;
  } else if (type === 'alert_no_clicks') {
    contentHtml = `
      <h2 style="font-size: 18px; font-weight: 600; color: #f43f5e; margin-bottom: 16px;">Campaign Alert: Inactive Link</h2>
      <p style="font-size: 14px; color: #94a3b8; line-height: 1.6; margin-bottom: 24px;">
        Hello,<br><br>
        We detected that your shortened link <strong>${linkCode}</strong> has registered **zero clicks** in the last <strong>24 hours</strong>.
      </p>
      
      <div style="background-color: #0f172a; border-left: 4px solid #f43f5e; border-radius: 6px; padding: 16px; margin-bottom: 28px;">
        <p style="font-size: 13px; color: #f1f5f9; margin: 0; font-family: monospace;"><strong>Link Code:</strong> ${linkCode}</p>
        <p style="font-size: 13px; color: #f1f5f9; margin: 6px 0 0 0; font-family: monospace;"><strong>Campaign Name:</strong> ${campaignName}</p>
      </div>

      <div style="text-align: center; margin: 35px 0;">
        <a href="http://localhost:3000/api/links" style="background-color: #f43f5e; color: #ffffff; text-decoration: none; padding: 12px 24px; border-radius: 8px; font-weight: 600; font-size: 14px; display: inline-block; box-shadow: 0 4px 6px -1px rgba(244, 63, 94, 0.4);">
          Manage Campaign Links
        </a>
      </div>
    `;
  } else {
    // Generic fallback template
    contentHtml = `
      <h2 style="font-size: 18px; font-weight: 600; color: #f8fafc; margin-bottom: 16px;">Notification Update</h2>
      <p style="font-size: 14px; color: #94a3b8; line-height: 1.6; margin-bottom: 24px;">
        You have received a new update on your TrackFlow dashboard. Log in to check details.
      </p>
    `;
  }

  return buildHtmlEnvelope(contentHtml);
}

/**
 * Dispatches an HTML email with optional attachments
 */
export async function sendEmail(payload: EmailPayload): Promise<nodemailer.SentMessageInfo> {
  const { recipient_email, subject, template_data } = payload;
  const htmlBody = compileTemplate(payload);

  const attachments: any[] = [];

  // Check if PDF path is provided and file exists
  if (template_data.file_path && fs.existsSync(template_data.file_path)) {
    const filename = path.basename(template_data.file_path);
    attachments.push({
      filename: filename,
      path: template_data.file_path
    });
  }

  const mailOptions = {
    from: smtpFrom,
    to: recipient_email,
    subject: subject,
    html: htmlBody,
    attachments: attachments
  };

  const info = await transporter.sendMail(mailOptions);
  return info;
}
