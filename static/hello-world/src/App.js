import React, { useEffect, useState } from 'react';
import { events, invoke } from '@forge/bridge';

function App() {
  const [data, setData] = useState(null);

  const handleFetchSuccess = (data) => {
    setData(data);
    if (data.length === 0) {
      throw new Error('No labels returned');
    }
  };
  const handleFetchError = () => {
    console.error('Failed to get label');
  };

  useEffect(() => {
    const fetchLabels = async () => invoke('fetchLabels');
    fetchLabels().then(handleFetchSuccess).catch(handleFetchError);
    const subscribeForIssueChangedEvent = () =>
      events.on('JIRA_ISSUE_CHANGED', () => {
        fetchLabels().then(handleFetchSuccess).catch(handleFetchError);
      });
    const subscription = subscribeForIssueChangedEvent();

    return () => {
      subscription.then((subscription) => subscription.unsubscribe());
    };
  }, []);

  if (!data) {
    return <div>Loading...</div>;
  }
  const labels = data.map((label) => <div>{label}</div>);
  return (
    <div>
      <span>Issue labels:</span>
      <div>{labels}</div>
    </div>
  );
}

export default App;
