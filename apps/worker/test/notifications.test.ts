import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { sendEmail, transporter } from '../src/emailService.js';
import path from 'path';
import fs from 'fs';

describe('Worker Notifications Email Compiler Unit Tests', () => {
  let sendMailSpy: any;
  const tempPdfPath = path.join(__dirname, 'mock_report_attachment.pdf');

  beforeAll(() => {
    // 1. Create a dummy file for attachment testing
    fs.writeFileSync(tempPdfPath, 'dummy pdf content');

    // 2. Set up Vitest spy on transporter.sendMail (executes clean JSON transport in test mode)
    sendMailSpy = vi.spyOn(transporter, 'sendMail');
  });

  afterAll(() => {
    // Clean up temporary attachment file
    if (fs.existsSync(tempPdfPath)) {
      try {
        fs.unlinkSync(tempPdfPath);
      } catch (_) {}
    }

    // Restore vitest mock spies
    sendMailSpy.mockRestore();
  });

  it('should compile and render alert_no_clicks email templates correctly', async () => {
    sendMailSpy.mockClear();

    const payload = {
      type: 'alert_no_clicks' as const,
      recipient_email: 'marketer@test.com',
      subject: 'TrackFlow Inactive Link Alert - testcode1',
      template_data: {
        link_code: 'testcode1',
        campaign_name: 'Summer Promotion Campaign'
      }
    };

    // 1. Execute direct sendEmail compiler pipeline
    const info = await sendEmail(payload);
    expect(info).toBeDefined();

    // 2. Assert transporter spy caught the JSON rendered email parameters
    expect(sendMailSpy).toHaveBeenCalledTimes(1);
    
    const mailArgs = sendMailSpy.mock.calls[0][0];
    expect(mailArgs.to).toBe('marketer@test.com');
    expect(mailArgs.subject).toBe('TrackFlow Inactive Link Alert - testcode1');
    expect(mailArgs.attachments).toEqual([]);
    
    // Assert premium HSL dark-themed HTML content matches design contracts
    expect(mailArgs.html).toContain('TrackFlow');
    expect(mailArgs.html).toContain('testcode1');
    expect(mailArgs.html).toContain('Summer Promotion Campaign');
    expect(mailArgs.html).toContain('zero clicks');
  });

  it('should compile report_ready template and attach PDF files correctly', async () => {
    sendMailSpy.mockClear();

    const payload = {
      type: 'report_ready' as const,
      recipient_email: 'client@test.com',
      subject: 'Twój raport analityczny TrackFlow',
      template_data: {
        user_name: 'Jan Kowalski',
        download_url: 'http://localhost:3000/api/reports/12345/download',
        period_start: '2026-05-18',
        period_end: '2026-05-24',
        file_path: tempPdfPath
      }
    };

    // 1. Execute direct sendEmail compiler pipeline
    const info = await sendEmail(payload);
    expect(info).toBeDefined();

    // 2. Assert transporter spy caught the JSON rendered email parameters with attachments
    expect(sendMailSpy).toHaveBeenCalledTimes(1);
    
    const mailArgs = sendMailSpy.mock.calls[0][0];
    expect(mailArgs.to).toBe('client@test.com');
    expect(mailArgs.subject).toBe('Twój raport analityczny TrackFlow');
    
    // Validate attachment
    expect(mailArgs.attachments.length).toBe(1);
    expect(mailArgs.attachments[0].filename).toBe('mock_report_attachment.pdf');
    // Nodemailer's jsonTransport reads the file from the path and embeds it as base64 string in 'content'
    expect(mailArgs.attachments[0].content).toBeDefined();

    // Validate html template parameters interpolation
    expect(mailArgs.html).toContain('Jan Kowalski');
    expect(mailArgs.html).toContain('2026-05-18');
    expect(mailArgs.html).toContain('2026-05-24');
    expect(mailArgs.html).toContain('http://localhost:3000/api/reports/12345/download');
  });
});
