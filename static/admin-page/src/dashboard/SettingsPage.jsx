import React from 'react';
import SectionMessage from '@atlaskit/section-message';
import { token } from '@atlaskit/tokens';
import { surfaceCard } from '../dashboard/presentation';
import { APPLICATION_VERSION } from './version';

const securityTopics = [
  {
    title: 'Data flow & outbound requests',
    text: 'The connector exchanges selected issue data with the configured Jira Cloud sites through their APIs and webhooks. The current manifest permits backend requests to *.atlassian.net. This is outbound data transfer, not a zero-egress or private-network guarantee. Administrators can also download configuration, issue exports and recovery files to their browsers.',
    href: 'https://developer.atlassian.com/platform/forge/runtime-egress-permissions/',
    link: 'Forge egress permissions'
  },
  {
    title: 'Platform controls & shared responsibility',
    text: 'Atlassian operates the Forge platform. Application authorization, dependency security, configuration, data handling and access to connected Jira sites remain app and administrator responsibilities. Forge hosting alone does not certify this application for enterprise compliance or guarantee its availability.',
    href: 'https://developer.atlassian.com/platform/forge/shared-responsibility-model/',
    link: 'Shared responsibility model'
  },
  {
    title: 'Forge-hosted backend',
    text: 'This source configuration uses Forge functions and hosted storage without a separately configured app-hosted backend. The browser UI and configured remote Jira sites are also part of the request flow. Hosting controls and security behavior depend on the deployed code, declared permissions and platform policies.',
    href: 'https://developer.atlassian.com/platform/forge/security/',
    link: 'Forge security documentation'
  },
  {
    title: 'Storage, secrets & data residency',
    text: 'Forge provides encryption at rest for its app storage; API tokens use the Forge secret store. Stored API tokens are not redisplayed in normal administration views. Administrators enter credentials in the browser and receive explicit one-time signing-secret handoffs when generating or rotating them. Data residency depends on the storage capability, installation location and applicable platform policies; remote Jira data and downloaded exports require separate consideration.',
    href: 'https://developer.atlassian.com/platform/forge/data-residency/',
    link: 'Forge data residency'
  }
];

export default function SettingsPage() {
  return <div className="settings-content" style={surfaceCard()}>
    <h2>Security & Architecture</h2>
    <SectionMessage appearance="information" title="Application architecture and platform responsibilities">
      <p>The backend uses Atlassian Forge. The descriptions below distinguish this application’s request flow from platform controls and deployment-dependent policies.</p>
    </SectionMessage>
    <dl className="application-version summary-list">
      <dt>Application version</dt><dd>{APPLICATION_VERSION}</dd>
      <dt>Deployment version</dt><dd>Not reported by this UI</dd>
    </dl>
    <figure className="architecture-figure">
      <h3>Logical request flow</h3>
<svg width="600" height="180" viewBox="0 0 600 180" role="img" aria-labelledby="architecture-title architecture-description" xmlns="http://www.w3.org/2000/svg">
<title id="architecture-title">Logical Jira and Forge request flow</title>
<desc id="architecture-description">A source Jira site sends events to the Forge app, which calls the configured remote Jira REST API. This diagram does not represent a private network or data-residency boundary.</desc>
                        {/* Logical service grouping, not a network boundary. */}
                        <rect x="10" y="10" width="580" height="160" rx="10" fill="none" stroke="#0052CC" strokeWidth="2" strokeDasharray="5,5" />
                        <text x="300" y="30" textAnchor="middle" fill="#0052CC" fontSize="12" fontWeight="bold">JIRA CLOUD SITES & FORGE SERVICES</text>

                        {/* Source Org */}
                        <rect x="40" y="60" width="120" height="80" rx="4" fill="#FFFFFF" stroke="#DFE1E6" strokeWidth="1" />
                        <rect x="40" y="60" width="120" height="6" rx="4" fill="#0052CC" />
                        <text x="100" y="105" textAnchor="middle" fill="#172B4D" fontSize="14" fontWeight="bold">Source Org</text>
                        <text x="100" y="125" textAnchor="middle" fill="#6B778C" fontSize="11">Jira Cloud</text>

                        {/* Target Org */}
                        <rect x="440" y="60" width="120" height="80" rx="4" fill="#FFFFFF" stroke="#DFE1E6" strokeWidth="1" />
                        <rect x="440" y="60" width="120" height="6" rx="4" fill="#0052CC" />
                        <text x="500" y="105" textAnchor="middle" fill="#172B4D" fontSize="14" fontWeight="bold">Target Org</text>
                        <text x="500" y="125" textAnchor="middle" fill="#6B778C" fontSize="11">Jira Cloud</text>

                        {/* Forge App (Middle) */}
                        <circle cx="300" cy="100" r="40" fill="#DEEBFF" stroke="#0052CC" strokeWidth="2" />
                        <text x="300" y="95" textAnchor="middle" fill="#0052CC" fontSize="12" fontWeight="bold">FORGE</text>
                        <text x="300" y="115" textAnchor="middle" fill="#0052CC" fontSize="10">App Runtime</text>

                        {/* Arrows */}
                        <defs>
                          <marker id="arrowhead" markerWidth="10" markerHeight="7" refX="0" refY="3.5" orient="auto">
                            <polygon points="0 0, 10 3.5, 0 7" fill="#0052CC" />
                          </marker>
                        </defs>

                        {/* Arrow 1: Source -> Forge */}
                        <line x1="170" y1="100" x2="250" y2="100" stroke="#0052CC" strokeWidth="2" markerEnd="url(#arrowhead)" />
                        <text x="210" y="90" textAnchor="middle" fill="#0052CC" fontSize="10">Webhook</text>

                        {/* Arrow 2: Forge -> Target */}
                        <line x1="350" y1="100" x2="430" y2="100" stroke="#0052CC" strokeWidth="2" markerEnd="url(#arrowhead)" />
                        <text x="390" y="90" textAnchor="middle" fill="#0052CC" fontSize="10">REST API</text>
                      </svg>
      <figcaption>Configured Jira sites exchange data through the Forge app. The grouping illustrates services, not a private-network, compliance or residency boundary. Actual synchronization follows the configured direction and scope.</figcaption>
    </figure>
    <div className="workflow-grid security-topics">
      {securityTopics.map(topic => <section key={topic.title}>
        <h3>{topic.title}</h3><p>{topic.text}</p>
        <a href={topic.href} target="_blank" rel="noopener noreferrer">{topic.link} ↗</a>
      </section>)}
    </div>
                    <div style={{ marginTop: '20px', borderTop: `1px solid ${token('color.border', '#DFE1E6')}`, paddingTop: '16px' }}>
                      <div className="workflow-grid" style={{ display: 'grid', gap: '24px', gridTemplateColumns: '1fr 1fr' }}>
                        <div>
                          <h3 style={{ marginBottom: '16px', fontSize: '16px', fontWeight: 600 }}>Current Capabilities</h3>
                          <ul style={{ listStyle: 'none', padding: 0, display: 'grid', gap: '6px' }}>
                            {[
                              'Real-time Bidirectional Issue Sync',
                              'Remote Jira connection without a target-site app installation',
                              'Comments and optional attachments, subject to Jira and connector limits',
                              'Bidirectional Issue Links & Subtasks Support',
                              'Epic & Parent/Child Relationships',
                              'Status, Priority & User Mapping',
                              'Issue Type Mapping',
                              'Custom Field Mapping',
                              'Initial backfill and opt-in recurring source reconciliation',
                              'Automatic Rate Limit Handling',
                              'Multi-Organization Support',
                              'JQL-based Project Filtering',
                              'Settings Import/Export'
                            ].map((item, i) => (
                              <li key={i} style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', color: token('color.text', '#172B4D') }}>
                                <span style={{ color: token('color.icon.success', '#36B37E') }}>•</span> {item}
                              </li>
                            ))}
                          </ul>
                        </div>

                        <div>
                          <h3 style={{ marginBottom: '16px', fontSize: '16px', fontWeight: 600 }}>Roadmap</h3>
                          <ul style={{ listStyle: 'none', padding: 0, display: 'grid', gap: '6px' }}>
                            {[
                              'Advanced Field Transformation Rules',
                              'Advanced Conflict Resolution',
                              'Sync History & Audit Log Export'
                            ].map((item, i) => (
                              <li key={i} style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', color: token('color.text.subtle', '#6B778C') }}>
                                <span style={{ fontSize: '12px', background: token('color.background.neutral', '#EBECF0'), padding: '2px 6px', borderRadius: '4px', fontWeight: 600 }}>PLANNED</span> {item}
                              </li>
                            ))}
                          </ul>
                        </div>
                      </div>
                    </div>

                    <div style={{ marginTop: '20px', borderTop: `1px solid ${token('color.border', '#DFE1E6')}`, paddingTop: '16px' }}>
                      <h3 style={{ marginBottom: '16px', fontSize: '16px', fontWeight: 600 }}>Developer Contact</h3>
                      <p style={{ fontSize: '13px', color: token('color.text', '#172B4D'), lineHeight: '1.5' }}>
                        <strong>Serdar Abali</strong><br />
                        <a href="mailto:serdar@live.fi" style={{ color: token('color.link', '#0052CC') }}>serdar@live.fi</a>
                      </p>
                      <p style={{ fontSize: '13px', color: token('color.text.subtle', '#6B778C'), marginTop: '8px' }}>
                        Please report any bugs or feature requests to the email above.
                      </p>
                    </div>

  </div>;
}
