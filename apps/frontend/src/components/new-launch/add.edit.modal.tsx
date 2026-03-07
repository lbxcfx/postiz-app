'use client';
import 'reflect-metadata';
import { useLaunchStore } from '@gitroom/frontend/components/new-launch/store';
import dayjs from 'dayjs';
import { FC, useEffect, useRef, useState } from 'react';
import { makeId } from '@gitroom/nestjs-libraries/services/make.is';
import { ManageModal } from '@gitroom/frontend/components/new-launch/manage.modal';
import { Integrations } from '@gitroom/frontend/components/launches/calendar.context';
import { useShallow } from 'zustand/react/shallow';
import { useExistingData } from '@gitroom/frontend/components/launches/helpers/use.existing.data';
import { newDayjs } from '@gitroom/frontend/components/layout/set.timezone';

export interface AddEditModalProps {
  dummy?: boolean;
  date: dayjs.Dayjs;
  integrations: Integrations[];
  allIntegrations?: Integrations[];
  selectedChannels?: string[];
  set?: any;
  focusedChannel?: string;
  addEditSets?: (data: any) => void;
  reopenModal: () => void;
  mutate: () => void;
  padding?: string;
  customClose?: () => void;
  onlyValues?: Array<{
    content: string;
    id?: string;
    image?: Array<{
      id: string;
      path: string;
    }>;
  }>;
}

export const AddEditModal: FC<AddEditModalProps> = (props) => {
  const { setAllIntegrations, setDate, setIsCreateSet, setDummy } =
    useLaunchStore(
      useShallow((state) => ({
        setAllIntegrations: state.setAllIntegrations,
        setDate: state.setDate,
        setIsCreateSet: state.setIsCreateSet,
        setDummy: state.setDummy,
      }))
    );

  useEffect(() => {
    setDummy(!!props.dummy);
    setDate(props.date || newDayjs());
    setAllIntegrations(props.allIntegrations || []);
    setIsCreateSet(!!props.addEditSets);
  }, []);

  return <AddEditModalInner {...props} />;
};

export const AddEditModalInner: FC<AddEditModalProps> = (props) => {
  const existingData = useExistingData();
  const initializedRef = useRef(false);
  const [selectionReady, setSelectionReady] = useState(false);
  const {
    selectedIntegrations,
    integrations,
    setSelectedIntegrations,
    setCurrent,
  } =
    useLaunchStore(
      useShallow((state) => ({
        integrations: state.integrations,
        selectedIntegrations: state.selectedIntegrations,
        setSelectedIntegrations: state.setSelectedIntegrations,
        setCurrent: state.setCurrent,
      }))
    );

  useEffect(() => {
    if (initializedRef.current) {
      return;
    }

    const needsPresetSelection =
      !!props?.set?.posts?.length ||
      !!existingData.integration ||
      !!props?.selectedChannels?.length;

    if (needsPresetSelection && integrations.length === 0) {
      return;
    }

    const preselected = new Map<
      string,
      { selectedIntegrations: Integrations; settings: any }
    >();
    const appendSelection = (integration?: Integrations, settings: any = {}) => {
      if (!integration?.id) {
        return;
      }
      if (!preselected.has(integration.id)) {
        preselected.set(integration.id, {
          selectedIntegrations: integration,
          settings: settings || {},
        });
      }
    };

    if (props?.set?.posts?.length) {
      for (const post of props?.set?.posts) {
        if (post.integration) {
          const integration = integrations.find(
            (i) => i.id === post.integration.id
          );
          appendSelection(integration, post.settings);
        }
      }
    }

    if (existingData.integration) {
      const integration = integrations.find(
        (i) => i.id === existingData.integration
      );
      appendSelection(integration, existingData.settings);
    }

    if (props?.selectedChannels?.length) {
      for (const channel of props.selectedChannels) {
        const integration = integrations.find((i) => i.id === channel);
        appendSelection(integration, {});
      }
    }

    const normalized = Array.from(preselected.values());
    if (normalized.length) {
      setSelectedIntegrations(normalized);
      const preferredCurrent =
        props.focusedChannel &&
        normalized.some(
          (item) => item.selectedIntegrations.id === props.focusedChannel
        )
          ? props.focusedChannel
          : normalized[0].selectedIntegrations.id;
      setCurrent(preferredCurrent);
    }

    initializedRef.current = true;
    setSelectionReady(true);
  }, [
    integrations,
    existingData.integration,
    existingData.settings,
    props?.set?.posts,
    props?.selectedChannels,
    props.focusedChannel,
    setCurrent,
    setSelectedIntegrations,
  ]);

  const waitingPresetSelection =
    !selectionReady &&
    (!!existingData.integration ||
      !!props?.selectedChannels?.length ||
      !!props?.set?.posts?.length);

  if (waitingPresetSelection) {
    return null;
  }

  if (existingData.integration && selectedIntegrations.length === 0) {
    return null;
  }

  return <AddEditModalInnerInner {...props} />;
};

export const AddEditModalInnerInner: FC<AddEditModalProps> = (props) => {
  const existingData = useExistingData();
  const {
    reset,
    addGlobalValue,
    addInternalValue,
    global,
    setCurrent,
    internal,
    setTags,
    setEditor,
    setRepeater,
  } = useLaunchStore(
    useShallow((state) => ({
      reset: state.reset,
      addGlobalValue: state.addGlobalValue,
      addInternalValue: state.addInternalValue,
      setCurrent: state.setCurrent,
      global: state.global,
      internal: state.internal,
      setTags: state.setTags,
      setEditor: state.setEditor,
      setRepeater: state.setRepeater,
    }))
  );

  useEffect(() => {
    if (existingData.integration) {
      if (existingData?.posts?.[0]?.intervalInDays) {
        setRepeater(existingData.posts[0].intervalInDays);
      }
      setTags(
        // @ts-ignore
        existingData?.posts?.[0]?.tags?.map((p: any) => ({
          label: p.tag.name,
          value: p.tag.name,
        })) || []
      );
      addInternalValue(
        0,
        existingData.integration,
        existingData.posts.map((post) => ({
          delay: post.delay,
          content:
            post.content.indexOf('<p>') > -1
              ? post.content
              : post.content
                  .split('\n')
                  .map((line: string) => `<p>${line}</p>`)
                  .join(''),
          id: post.id,
          // @ts-ignore
          media: post.image as any[],
        }))
      );
      setCurrent(existingData.integration);
    } else {
      setEditor('normal');
    }

    if (props.focusedChannel) {
      setCurrent(props.focusedChannel);
    }

    addGlobalValue(
      0,
      props.onlyValues?.length
        ? props.onlyValues.map((p) => ({
            content:
              p.content.indexOf('<p>') > -1
                ? p.content
                : p.content
                    .split('\n')
                    .map((line: string) => `<p>${line}</p>`)
                    .join(''),
            id: makeId(10),
            media: p.image || [],
          }))
        : props.set?.posts?.length
        ? props.set.posts[0].value.map((p: any) => ({
            id: makeId(10),
            content: p.content
              .split('\n')
              .map((line: string) => `<p>${line}</p>`)
              .join(''),
            // @ts-ignore
            media: p.media,
          }))
        : [
            {
              content: '',
              id: makeId(10),
              media: [],
            },
          ]
    );

    return () => {
      reset();
    };
  }, []);

  if (!global.length && !internal.length) {
    return null;
  }

  return (
    <>
      <style>
        {`#support-discord {display: none !important;}`}
      </style>
      <ManageModal {...props} />
    </>
  );
};
