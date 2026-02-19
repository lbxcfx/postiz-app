import { Metadata } from 'next';
import { isGeneralServerSide } from '@gitroom/helpers/utils/is.general.server.side';
import { FactoryConsole } from '@gitroom/frontend/components/content-factory/factory.console';

export const metadata: Metadata = {
  title: `${isGeneralServerSide() ? 'Postiz' : 'Gitroom'} Publish`,
  description: '',
};

export default async function Page() {
  return (
    <FactoryConsole
      view="publish"
      title="发布调度"
      subtitle="选择账号、设置定时并追踪 PublishJob 状态"
      badge="PUBLISH"
    />
  );
}
