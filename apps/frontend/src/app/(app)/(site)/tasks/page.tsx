import { Metadata } from 'next';
import { isGeneralServerSide } from '@gitroom/helpers/utils/is.general.server.side';
import { FactoryConsole } from '@gitroom/frontend/components/content-factory/factory.console';

export const metadata: Metadata = {
  title: `${isGeneralServerSide() ? 'Postiz' : 'Gitroom'} Tasks`,
  description: '',
};

export default async function Page() {
  return (
    <FactoryConsole
      view="tasks"
      title="任务中心"
      subtitle="查看任务状态、重试与取消操作"
      badge="TASKS"
    />
  );
}
