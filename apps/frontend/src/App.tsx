import React, { useState } from 'react';
import { AuthProvider, useAuth } from './context/AuthContext.js';
import { LoginPage } from './components/LoginPage.js';
import { DashboardLayout } from './components/DashboardLayout.js';
import { LinkList } from './components/LinkList.js';
import { StatsDashboard } from './components/StatsDashboard.js';
import { ReportsPanel } from './components/ReportsPanel.js';

const AppContent: React.FC = () => {
  const { isAuthenticated } = useAuth();
  const [currentTab, setCurrentTab] = useState('links');

  if (!isAuthenticated) {
    return <LoginPage onSuccess={() => setCurrentTab('links')} />;
  }

  // Basic Router matching currentTab state
  const renderContent = () => {
    if (currentTab === 'links') {
      return (
        <LinkList 
          onSelectStats={(linkId) => setCurrentTab(`stats-${linkId}`)} 
        />
      );
    }

    if (currentTab.startsWith('stats-')) {
      const linkId = currentTab.substring('stats-'.length);
      return (
        <StatsDashboard 
          linkId={linkId} 
          onBack={() => setCurrentTab('links')} 
        />
      );
    }

    if (currentTab === 'reports') {
      return <ReportsPanel />;
    }

    return (
      <div className="glass-panel" style={{ padding: '2rem', textAlign: 'center' }}>
        <h2>404 Not Found</h2>
        <p style={{ color: 'var(--text-secondary)', marginTop: '0.5rem' }}>This page doesn't exist.</p>
      </div>
    );
  };

  return (
    <DashboardLayout currentTab={currentTab} setCurrentTab={setCurrentTab}>
      {renderContent()}
    </DashboardLayout>
  );
};

export const App: React.FC = () => {
  return (
    <AuthProvider>
      <AppContent />
    </AuthProvider>
  );
};

export default App;
