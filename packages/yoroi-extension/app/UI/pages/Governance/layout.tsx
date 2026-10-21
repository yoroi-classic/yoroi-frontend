import React from 'react';
import GeneralPageLayout from '../../layout/GeneralPageLayout';
import NavBarContainerRevamp from '../../../containers/NavBarContainerRevamp';
import NavBarTitle from '../../../components/topbar/NavBarTitle';
import { Stack } from '@mui/material';

type Props = {
  stores: any;
  children: React.ReactNode;
};

const GovernanceLayout = ({ stores, children }: Props): any => {
  return (
    <GeneralPageLayout
      stores={stores}
      navbar={<NavBarContainerRevamp stores={stores} title={<NavBarTitle title={'Governance'} />} />}
    >
      <Stack direction="column" justifyContent="space-between" alignItems="center" height="100%">
        {children}
      </Stack>
    </GeneralPageLayout>
  );
};

export default GovernanceLayout;
