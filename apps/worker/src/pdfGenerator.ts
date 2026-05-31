import { db, Prisma } from '@trackflow/db';
import puppeteer from 'puppeteer';
import fs from 'fs';
import path from 'path';

export interface ReportPayload {
  report_id: string;
  requested_by: string;
  date_from: string;
  date_to: string;
  client_id?: string | null;
  link_id?: string | null;
  recipient_email?: string | null;
}

export interface GenerationResult {
  file_path: string;
  total_clicks: number;
  unique_clicks: number;
}

/**
 * Generates an SVG Bar Chart for clicks over time
 */
function generateSvgBarChart(data: { timestamp: Date; count: number }[]): string {
  if (data.length === 0) {
    return `
      <div style="text-align: center; color: hsl(215, 20.2%, 65.1%); padding: 40px 0; font-size: 13px;">
        No click activity recorded in this period.
      </div>
    `;
  }

  const width = 600;
  const height = 150;
  const paddingLeft = 40;
  const paddingRight = 10;
  const paddingTop = 20;
  const paddingBottom = 30;

  const chartWidth = width - paddingLeft - paddingRight;
  const chartHeight = height - paddingTop - paddingBottom;

  const maxCount = Math.max(...data.map((d) => d.count), 5);
  const step = chartWidth / data.length;
  const barWidth = Math.max(2, Math.floor(step * 0.7));

  let barsSvg = '';
  let xAxisSvg = '';
  let yAxisSvg = '';

  // Render bars
  data.forEach((d, idx) => {
    const x = paddingLeft + idx * step + (step - barWidth) / 2;
    const barHeight = (d.count / maxCount) * chartHeight;
    const y = height - paddingBottom - barHeight;

    barsSvg += `
      <rect x="${x}" y="${y}" width="${barWidth}" height="${barHeight}" rx="3" fill="url(#barGradient)">
        <title>${d.count} clicks</title>
      </rect>
    `;

    // Render X-axis labels dynamically to avoid overcrowding
    const maxLabels = 7;
    const labelInterval = Math.max(1, Math.ceil(data.length / maxLabels));
    if (idx % labelInterval === 0 || idx === data.length - 1) {
      const dateStr = d.timestamp.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      xAxisSvg += `
        <text x="${x + barWidth / 2}" y="${height - 10}" font-family="'Outfit', sans-serif" font-size="9" fill="hsl(215, 20.2%, 65.1%)" text-anchor="middle">
          ${dateStr}
        </text>
      `;
    }
  });

  // Render Y-axis ticks and horizontal gridlines
  const yTicks = 4;
  for (let i = 0; i <= yTicks; i++) {
    const value = Math.round((i / yTicks) * maxCount);
    const y = height - paddingBottom - (i / yTicks) * chartHeight;

    yAxisSvg += `
      <text x="${paddingLeft - 10}" y="${y + 3}" font-family="'Outfit', sans-serif" font-size="9" fill="hsl(215, 20.2%, 65.1%)" text-anchor="end">
        ${value}
      </text>
      <line x1="${paddingLeft}" y1="${y}" x2="${width - paddingRight}" y2="${y}" stroke="hsl(217.2, 32.6%, 17.5%)" stroke-dasharray="2,4" />
    `;
  }

  return `
    <svg width="100%" height="100%" viewBox="0 0 ${width} ${height}" style="overflow: visible;">
      <defs>
        <linearGradient id="barGradient" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="hsl(263.4, 70%, 65%)" />
          <stop offset="100%" stop-color="hsl(263.4, 70%, 45%)" />
        </linearGradient>
      </defs>
      ${yAxisSvg}
      <line x1="${paddingLeft}" y1="${height - paddingBottom}" x2="${width - paddingRight}" y2="${height - paddingBottom}" stroke="hsl(217.2, 32.6%, 25%)" />
      ${barsSvg}
      ${xAxisSvg}
    </svg>
  `;
}

/**
 * Aggregates database statistics and exports a premium PDF file using Puppeteer
 */
export async function generateReportPdf(payload: ReportPayload): Promise<GenerationResult> {
  const { report_id, date_from, date_to, client_id, link_id } = payload;
  const fromDate = new Date(date_from);
  const toDate = new Date(date_to);

  // 1. Fetch matching active, non-deleted Link IDs
  let linkIds: string[] = [];

  if (link_id) {
    const link = await db.link.findFirst({
      where: { id: link_id }
    });
    if (link) {
      linkIds = [link.id];
    }
  } else if (client_id) {
    const links = await db.link.findMany({
      where: { client_id, deleted_at: null },
      select: { id: true }
    });
    linkIds = links.map((l) => l.id);
  } else {
    // Default to all non-deleted links in the system
    const links = await db.link.findMany({
      where: { deleted_at: null },
      select: { id: true }
    });
    linkIds = links.map((l) => l.id);
  }

  let totalClicks = 0;
  let uniqueClicks = 0;
  let clicksOverTime: { timestamp: Date; count: number }[] = [];
  let countryStats: { country: string; count: number }[] = [];
  let deviceStats: { device_type: string; count: number }[] = [];
  let referrerStats: { referrer: string; count: number }[] = [];

  if (linkIds.length > 0) {
    // 2. Perform stats aggregations concurrently
    const [counts, rawClicksOverTime, byCountry, byDevice, byReferrer] = await Promise.all([
      db.$queryRaw<any[]>`
        SELECT 
          COUNT(id)::int AS total_clicks,
          COUNT(DISTINCT ip_hash)::int AS unique_clicks
        FROM clicks
        WHERE 
          link_id = ANY(${linkIds}::uuid[])
          AND clicked_at >= ${fromDate}::timestamptz
          AND clicked_at <= ${toDate}::timestamptz
      `,
      db.$queryRaw<any[]>`
        SELECT 
          date_trunc('day', clicked_at) AS timestamp, 
          COUNT(id)::int AS count 
        FROM clicks 
        WHERE 
          link_id = ANY(${linkIds}::uuid[]) 
          AND clicked_at >= ${fromDate}::timestamptz 
          AND clicked_at <= ${toDate}::timestamptz 
        GROUP BY timestamp 
        ORDER BY timestamp ASC
      `,
      db.click.groupBy({
        by: ['country'],
        where: {
          link_id: { in: linkIds },
          clicked_at: { gte: fromDate, lte: toDate }
        },
        _count: { id: true },
        orderBy: { _count: { id: 'desc' } }
      }),
      db.click.groupBy({
        by: ['device_type'],
        where: {
          link_id: { in: linkIds },
          clicked_at: { gte: fromDate, lte: toDate }
        },
        _count: { id: true },
        orderBy: { _count: { id: 'desc' } }
      }),
      db.click.groupBy({
        by: ['referrer'],
        where: {
          link_id: { in: linkIds },
          clicked_at: { gte: fromDate, lte: toDate }
        },
        _count: { id: true },
        orderBy: { _count: { id: 'desc' } }
      })
    ]);

    totalClicks = counts[0]?.total_clicks || 0;
    uniqueClicks = counts[0]?.unique_clicks || 0;

    // Process daily click timeline
    clicksOverTime = rawClicksOverTime.map((row) => ({
      timestamp: new Date(row.timestamp),
      count: row.count
    }));

    // Process Country Stats (null -> 'Unknown')
    countryStats = byCountry.map((item) => ({
      country: item.country || 'Unknown',
      count: item._count.id
    }));

    // Process Device Stats (null -> 'desktop')
    deviceStats = byDevice.map((item) => ({
      device_type: item.device_type || 'desktop',
      count: item._count.id
    }));

    // Process Referrers (Group subdomains, clean www, limit to Top 5)
    const referrerMap = new Map<string, number>();
    for (const item of byReferrer) {
      let host = 'Direct / Unknown';
      if (item.referrer) {
        try {
          const url = new URL(item.referrer);
          host = url.hostname.replace('www.', '');
        } catch (err) {
          host = item.referrer;
        }
      }
      referrerMap.set(host, (referrerMap.get(host) || 0) + item._count.id);
    }

    referrerStats = Array.from(referrerMap.entries())
      .map(([referrer, count]) => ({ referrer, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);
  }

  // Calculate percentages for device stats for progress bars
  const totalDeviceCount = deviceStats.reduce((sum, d) => sum + d.count, 0) || 1;
  const devicePercentages = {
    desktop: Math.round(((deviceStats.find((d) => d.device_type === 'desktop')?.count || 0) / totalDeviceCount) * 100),
    mobile: Math.round(((deviceStats.find((d) => d.device_type === 'mobile')?.count || 0) / totalDeviceCount) * 100),
    tablet: Math.round(((deviceStats.find((d) => d.device_type === 'tablet')?.count || 0) / totalDeviceCount) * 100)
  };

  // 3. Build beautifully designed HSL Dark Mode HTML report template
  const svgChartHtml = generateSvgBarChart(clicksOverTime);

  const formattedDateFrom = fromDate.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  const formattedDateTo = toDate.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });

  const htmlContent = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <title>TrackFlow Analytics Report</title>
      <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700&display=swap" rel="stylesheet">
      <style>
        :root {
          --bg-color: hsl(222.2, 84%, 4.9%);
          --card-bg: hsl(217.2, 32.6%, 17.5%);
          --card-border: hsl(217.2, 32.6%, 25%);
          --text-main: hsl(210, 40%, 98%);
          --text-sub: hsl(215, 20.2%, 65.1%);
          --primary: hsl(263.4, 70%, 50.4%);
          --secondary: hsl(199, 89%, 48%);
          --success: hsl(142.1, 70.6%, 45.3%);
        }
        
        * {
          box-sizing: border-box;
          margin: 0;
          padding: 0;
        }
        
        body {
          font-family: 'Outfit', sans-serif;
          background-color: var(--bg-color);
          color: var(--text-main);
          padding: 40px;
          -webkit-print-color-adjust: exact;
          print-color-adjust: exact;
        }
        
        .report-container {
          max-width: 700px;
          margin: 0 auto;
        }
        
        header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding-bottom: 25px;
          border-bottom: 1px solid var(--card-border);
          margin-bottom: 30px;
        }
        
        .logo-area h1 {
          font-size: 26px;
          font-weight: 700;
          letter-spacing: -0.5px;
          background: linear-gradient(90deg, hsl(263.4, 70%, 65%), hsl(199, 89%, 55%));
          -webkit-background-clip: text;
          -webkit-text-fill-color: transparent;
        }
        
        .logo-area p {
          font-size: 11px;
          color: var(--text-sub);
          text-transform: uppercase;
          letter-spacing: 1.5px;
          margin-top: 2px;
        }
        
        .meta-area {
          text-align: right;
        }
        
        .meta-area h2 {
          font-size: 14px;
          font-weight: 600;
          color: var(--text-main);
        }
        
        .meta-area p {
          font-size: 11px;
          color: var(--text-sub);
          margin-top: 3px;
        }
        
        .dashboard-grid {
          display: grid;
          grid-template-columns: repeat(2, 1fr);
          gap: 20px;
          margin-bottom: 30px;
        }
        
        .stat-card {
          background: var(--card-bg);
          border: 1px solid var(--card-border);
          border-radius: 12px;
          padding: 20px;
          position: relative;
          overflow: hidden;
        }
        
        .stat-card::before {
          content: '';
          position: absolute;
          top: 0;
          left: 0;
          width: 4px;
          height: 100%;
        }
        
        .stat-card.total::before {
          background: var(--primary);
        }
        
        .stat-card.unique::before {
          background: var(--success);
        }
        
        .stat-card .label {
          font-size: 11px;
          font-weight: 600;
          text-transform: uppercase;
          letter-spacing: 1px;
          color: var(--text-sub);
        }
        
        .stat-card .val {
          font-size: 32px;
          font-weight: 700;
          margin-top: 8px;
          color: var(--text-main);
        }
        
        .section-card {
          background: var(--card-bg);
          border: 1px solid var(--card-border);
          border-radius: 12px;
          padding: 24px;
          margin-bottom: 30px;
        }
        
        .section-card h3 {
          font-size: 12px;
          font-weight: 600;
          text-transform: uppercase;
          letter-spacing: 1px;
          color: var(--text-main);
          margin-bottom: 20px;
          padding-bottom: 8px;
          border-bottom: 1px solid var(--card-border);
        }

        .chart-box {
          height: 160px;
          display: flex;
          align-items: center;
          justify-content: center;
        }
        
        .breakdowns-grid {
          display: grid;
          grid-template-columns: repeat(2, 1fr);
          gap: 20px;
          margin-bottom: 30px;
        }
        
        .table-container {
          background: var(--card-bg);
          border: 1px solid var(--card-border);
          border-radius: 12px;
          padding: 20px;
        }
        
        .table-container h3 {
          font-size: 11px;
          font-weight: 600;
          text-transform: uppercase;
          letter-spacing: 1.5px;
          color: var(--text-main);
          margin-bottom: 15px;
          padding-bottom: 8px;
          border-bottom: 1px solid var(--card-border);
        }
        
        table {
          width: 100%;
          border-collapse: collapse;
          font-size: 12px;
        }
        
        th {
          text-align: left;
          font-weight: 600;
          color: var(--text-sub);
          padding-bottom: 8px;
        }
        
        td {
          padding: 8px 0;
          border-bottom: 1px solid hsl(217.2, 32.6%, 22%);
          color: var(--text-main);
        }
        
        tr:last-child td {
          border-bottom: none;
        }

        td.count-cell {
          text-align: right;
          font-weight: 600;
        }
        
        .device-bar-container {
          display: flex;
          flex-direction: column;
          gap: 14px;
          font-size: 12px;
        }
        
        .device-row {
          display: flex;
          align-items: center;
          justify-content: space-between;
        }
        
        .device-info {
          display: flex;
          align-items: center;
          gap: 8px;
          width: 90px;
        }
        
        .device-dot {
          width: 8px;
          height: 8px;
          border-radius: 50%;
        }
        
        .device-dot.desktop { background-color: var(--primary); }
        .device-dot.mobile { background-color: var(--secondary); }
        .device-dot.tablet { background-color: var(--success); }
        
        .device-bar-outer {
          flex: 1;
          height: 6px;
          background: hsl(217.2, 32.6%, 25%);
          border-radius: 3px;
          margin: 0 15px;
          overflow: hidden;
          position: relative;
        }
        
        .device-bar-inner {
          height: 100%;
          border-radius: 3px;
          position: absolute;
          left: 0;
          top: 0;
        }
        
        .device-bar-inner.desktop { background-color: var(--primary); }
        .device-bar-inner.mobile { background-color: var(--secondary); }
        .device-bar-inner.tablet { background-color: var(--success); }

        .device-pct {
          width: 40px;
          text-align: right;
          font-weight: 600;
        }
        
        footer {
          text-align: center;
          font-size: 10px;
          color: var(--text-sub);
          border-top: 1px solid var(--card-border);
          padding-top: 20px;
          margin-top: 40px;
        }
      </style>
    </head>
    <body>
      <div class="report-container">
        <header>
          <div class="logo-area">
            <h1>TrackFlow</h1>
            <p>Campaign Analytics Report</p>
          </div>
          <div class="meta-area">
            <h2>Report ID: ${report_id.slice(0, 8)}...</h2>
            <p>${formattedDateFrom} - ${formattedDateTo}</p>
          </div>
        </header>

        <section class="dashboard-grid">
          <div class="stat-card total">
            <div class="label">Total Clicks</div>
            <div class="val">${totalClicks.toLocaleString()}</div>
          </div>
          <div class="stat-card unique">
            <div class="label">Unique Visitors</div>
            <div class="val">${uniqueClicks.toLocaleString()}</div>
          </div>
        </section>

        <section class="section-card">
          <h3>Click Performance Timeline</h3>
          <div class="chart-box">
            ${svgChartHtml}
          </div>
        </section>

        <section class="breakdowns-grid">
          <div class="table-container">
            <h3>Top Referrers</h3>
            <table>
              <thead>
                <tr>
                  <th>Source Domain</th>
                  <th style="text-align: right;">Clicks</th>
                </tr>
              </thead>
              <tbody>
                ${
                  referrerStats.length > 0
                    ? referrerStats
                        .map(
                          (r) => `
                        <tr>
                          <td>${r.referrer}</td>
                          <td class="count-cell">${r.count.toLocaleString()}</td>
                        </tr>
                      `
                        )
                        .join('')
                    : `<tr><td colspan="2" style="color: var(--text-sub); text-align: center; padding: 20px 0;">No referral data available</td></tr>`
                }
              </tbody>
            </table>
          </div>

          <div class="table-container">
            <h3>Device Breakdown</h3>
            <div class="device-bar-container" style="margin-top: 10px;">
              <div class="device-row">
                <div class="device-info">
                  <div class="device-dot desktop"></div>
                  <span>Desktop</span>
                </div>
                <div class="device-bar-outer">
                  <div class="device-bar-inner desktop" style="width: ${devicePercentages.desktop}%;"></div>
                </div>
                <span class="device-pct">${devicePercentages.desktop}%</span>
              </div>
              <div class="device-row">
                <div class="device-info">
                  <div class="device-dot mobile"></div>
                  <span>Mobile</span>
                </div>
                <div class="device-bar-outer">
                  <div class="device-bar-inner mobile" style="width: ${devicePercentages.mobile}%;"></div>
                </div>
                <span class="device-pct">${devicePercentages.mobile}%</span>
              </div>
              <div class="device-row">
                <div class="device-info">
                  <div class="device-dot tablet"></div>
                  <span>Tablet</span>
                </div>
                <div class="device-bar-outer">
                  <div class="device-bar-inner tablet" style="width: ${devicePercentages.tablet}%;"></div>
                </div>
                <span class="device-pct">${devicePercentages.tablet}%</span>
              </div>
            </div>
          </div>
        </section>

        <section class="table-container" style="margin-bottom: 30px;">
          <h3>Geographic Breakdown</h3>
          <table>
            <thead>
              <tr>
                <th>Country</th>
                <th style="text-align: right;">Clicks</th>
              </tr>
            </thead>
            <tbody>
              ${
                countryStats.length > 0
                  ? countryStats
                      .slice(0, 5)
                      .map(
                        (c) => `
                      <tr>
                        <td>${c.country}</td>
                        <td class="count-cell">${c.count.toLocaleString()}</td>
                      </tr>
                    `
                      )
                      .join('')
                  : `<tr><td colspan="2" style="color: var(--text-sub); text-align: center; padding: 20px 0;">No geographic data available</td></tr>`
              }
            </tbody>
          </table>
        </section>

        <footer>
          <p>Generated automatically by TrackFlow v1.0. All stats are GDPR-compliant.</p>
          <p style="margin-top: 5px;">&copy; 2026 TrackFlow Inc. All rights reserved.</p>
        </footer>
      </div>
    </body>
    </html>
  `;

  // 4. Set up storage folder on shared volume path (recursively created if needed)
  const storageDir = process.env.PDF_STORAGE_PATH || './storage/reports';
  if (!fs.existsSync(storageDir)) {
    fs.mkdirSync(storageDir, { recursive: true });
  }

  const filePath = path.join(storageDir, `report_${report_id}.pdf`);

  // Determine the best executable path for Puppeteer (supports local host Chrome and Docker container Chromium)
  let executablePath: string | undefined = process.env.PUPPETEER_EXECUTABLE_PATH;
  if (!executablePath && process.platform === 'win32') {
    const winChromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
    if (fs.existsSync(winChromePath)) {
      executablePath = winChromePath;
    }
  }

  // 5. Fire Puppeteer in headless mode to render and print PDF
  const browser = await puppeteer.launch({
    headless: true,
    executablePath,
    timeout: 30000,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-default-apps',
      '--no-first-run'
    ]
  });

  try {
    const page = await browser.newPage();
    // Use 'domcontentloaded' instead of 'networkidle0' — we set static HTML content
    // with no external resources, so waiting for network idle can hang unnecessarily
    await page.setContent(htmlContent, { waitUntil: 'domcontentloaded', timeout: 15000 });

    // Print A4 PDF
    const pdfBuffer = await page.pdf({
      format: 'A4',
      printBackground: true,
      timeout: 15000,
      margin: {
        top: '15mm',
        bottom: '15mm',
        left: '15mm',
        right: '15mm'
      }
    });

    fs.writeFileSync(filePath, pdfBuffer);
  } finally {
    await browser.close();
  }

  // Ensure path starts with standard volume mapping format for internal docker links or absolute mappings
  // The contract says: file_path = '/app/storage/reports/report_{report_id}.pdf' or equivalent mapped directory
  // If running inside docker /app/storage/reports, if running locally use absolute path or mapped storage
  const finalFilePath = path.resolve(filePath).replace(/\\/g, '/');

  return {
    file_path: finalFilePath,
    total_clicks: totalClicks,
    unique_clicks: uniqueClicks
  };
}
