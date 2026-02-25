'use client';

import { FC, ReactNode } from 'react';
import { useUser } from '@gitroom/frontend/components/layout/user.context';
import { useVariables } from '@gitroom/react/helpers/variable.context';
import { useT } from '@gitroom/react/translation/get.transation.service.client';
import { MenuItem } from '@gitroom/frontend/components/new-layout/menu-item';
import { usePathname } from 'next/navigation';

interface MenuItemInterface {
  name: string;
  icon: ReactNode;
  path: string;
  role?: string[];
  hide?: boolean;
  requireBilling?: boolean;
}

export const useMenuItem = () => {
  const { isGeneral } = useVariables();
  const t = useT();
  const pathname = usePathname();

  const firstMenu = [
    {
      name: t('materials', 'Materials'),
      icon: (
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="22"
          height="22"
          viewBox="0 0 24 24"
          fill="none"
        >
          <path
            d="M4 6.5C4 5.11929 5.11929 4 6.5 4H14.5C15.8807 4 17 5.11929 17 6.5V14.5C17 15.8807 15.8807 17 14.5 17H6.5C5.11929 17 4 15.8807 4 14.5V6.5Z"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinejoin="round"
          />
          <path
            d="M7 9.25H14"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
          />
          <path
            d="M7 12H12.5"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
          />
          <path
            d="M8.5 17H17.5C18.8807 17 20 15.8807 20 14.5V8.5"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
          />
        </svg>
      ),
      path: '/materials',
    },
    {
      name: t('factory_creation', 'Creation'),
      icon: (
        <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none">
          <path d="M5 7.5C5 6.11929 6.11929 5 7.5 5H12.5C13.8807 5 15 6.11929 15 7.5V12.5C15 13.8807 13.8807 15 12.5 15H7.5C6.11929 15 5 13.8807 5 12.5V7.5Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
          <path d="M10 15V19" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          <path d="M8 19H12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          <path d="M17 9L18 11L20 12L18 13L17 15L16 13L14 12L16 11L17 9Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
        </svg>
      ),
      path: '/creation',
    },
    {
      name: t('media', 'Media'),
      icon: (
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="20"
          height="21"
          viewBox="0 0 20 21"
          fill="none"
        >
          <path
            d="M7.50008 3L6.66675 7.16667M13.3334 3L12.5001 7.16667M18.3334 7.16667H1.66675M5.66675 18H14.3334C15.7335 18 16.4336 18 16.9684 17.7275C17.4388 17.4878 17.8212 17.1054 18.0609 16.635C18.3334 16.1002 18.3334 15.4001 18.3334 14V7C18.3334 5.59987 18.3334 4.8998 18.0609 4.36502C17.8212 3.89462 17.4388 3.51217 16.9684 3.27248C16.4336 3 15.7335 3 14.3334 3H5.66675C4.26662 3 3.56655 3 3.03177 3.27248C2.56137 3.51217 2.17892 3.89462 1.93923 4.36502C1.66675 4.8998 1.66675 5.59987 1.66675 7V14C1.66675 15.4001 1.66675 16.1002 1.93923 16.635C2.17892 17.1054 2.56137 17.4878 3.03177 17.7275C3.56655 18 4.26662 18 5.66675 18Z"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      ),
      path: '/media',
    },
    {
      name: isGeneral ? t('calendar', 'Calendar') : t('launches', 'Launches'),
      icon: (
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="21"
          height="23"
          viewBox="0 0 21 23"
          fill="none"
        >
          <path
            d="M19.5 9.5H1.5M14.5 1.5V5.5M6.5 1.5V5.5M6.3 21.5H14.7C16.3802 21.5 17.2202 21.5 17.862 21.173C18.4265 20.8854 18.8854 20.4265 19.173 19.862C19.5 19.2202 19.5 18.3802 19.5 16.7V8.3C19.5 6.61984 19.5 5.77976 19.173 5.13803C18.8854 4.57354 18.4265 4.1146 17.862 3.82698C17.2202 3.5 16.3802 3.5 14.7 3.5H6.3C4.61984 3.5 3.77976 3.5 3.13803 3.82698C2.57354 4.1146 2.1146 4.57354 1.82698 5.13803C1.5 5.77976 1.5 6.61984 1.5 8.3V16.7C1.5 18.3802 1.5 19.2202 1.82698 19.862C2.1146 20.4265 2.57354 20.8854 3.13803 21.173C3.77976 21.5 4.61984 21.5 6.3 21.5Z"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      ),
      path: pathname.startsWith('/creation') ? '/creation?schedule=1' : '/launches',
    },
    {
      name: t('factory_analysis', 'Analysis'),
      icon: (
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="22"
          height="22"
          viewBox="0 0 24 24"
          fill="none"
        >
          <path
            d="M4 13H10V20H4V13ZM14 4H20V20H14V4ZM4 4H10V10H4V4Z"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinejoin="round"
          />
        </svg>
      ),
      path: '/dashboard',
    },
  ] satisfies MenuItemInterface[] as MenuItemInterface[];

  const secondMenu = [
    {
      name: t('billing', 'Billing'),
      icon: (
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="20"
          height="21"
          viewBox="0 0 20 21"
          fill="none"
        >
          <path
            d="M7.08341 12.7225C7.08341 13.7964 7.95397 14.667 9.02786 14.667H10.8334C11.984 14.667 12.9167 13.7343 12.9167 12.5837C12.9167 11.4331 11.984 10.5003 10.8334 10.5003H9.16675C8.01615 10.5003 7.08341 9.56759 7.08341 8.41699C7.08341 7.2664 8.01615 6.33366 9.16675 6.33366H10.9723C12.0462 6.33366 12.9167 7.20422 12.9167 8.2781M10.0001 5.08366V6.33366M10.0001 14.667V15.917M18.3334 10.5003C18.3334 15.1027 14.6025 18.8337 10.0001 18.8337C5.39771 18.8337 1.66675 15.1027 1.66675 10.5003C1.66675 5.89795 5.39771 2.16699 10.0001 2.16699C14.6025 2.16699 18.3334 5.89795 18.3334 10.5003Z"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      ),
      path: '/billing',
      role: ['ADMIN', 'SUPERADMIN'],
      requireBilling: true,
    },
    {
      name: t('settings', 'Settings'),
      icon: (
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="20"
          height="21"
          viewBox="0 0 20 21"
          fill="none"
        >
          <path
            d="M7.82912 16.6429L8.31616 17.7383C8.46094 18.0644 8.69722 18.3414 8.99635 18.5358C9.29547 18.7303 9.64458 18.8337 10.0013 18.8337C10.3581 18.8337 10.7072 18.7303 11.0063 18.5358C11.3055 18.3414 11.5417 18.0644 11.6865 17.7383L12.1736 16.6429C12.3469 16.2542 12.6386 15.9302 13.0069 15.717C13.3776 15.5032 13.8063 15.4121 14.2319 15.4568L15.4236 15.5837C15.7783 15.6212 16.1363 15.555 16.4541 15.3931C16.772 15.2312 17.0361 14.9806 17.2143 14.6716C17.3928 14.3628 17.4778 14.0089 17.4591 13.6527C17.4403 13.2966 17.3186 12.9535 17.1087 12.6651L16.4032 11.6957C16.152 11.3479 16.0177 10.9293 16.0199 10.5003C16.0198 10.0725 16.1553 9.65562 16.4069 9.30959L17.1125 8.34014C17.3223 8.05179 17.444 7.70872 17.4628 7.35255C17.4815 6.99639 17.3965 6.64244 17.218 6.33366C17.0398 6.02469 16.7757 5.77407 16.4578 5.61218C16.14 5.4503 15.782 5.3841 15.4273 5.42162L14.2356 5.54847C13.81 5.59317 13.3813 5.50209 13.0106 5.28829C12.6415 5.07387 12.3498 4.74812 12.1773 4.35773L11.6865 3.26236C11.5417 2.9363 11.3055 2.65925 11.0063 2.46482C10.7072 2.27039 10.3581 2.16693 10.0013 2.16699C9.64458 2.16693 9.29547 2.27039 8.99635 2.46482C8.69722 2.65925 8.46094 2.9363 8.31616 3.26236L7.82912 4.35773C7.65656 4.74812 7.36485 5.07387 6.99579 5.28829C6.62513 5.50209 6.19634 5.59317 5.77079 5.54847L4.57542 5.42162C4.22069 5.3841 3.8627 5.4503 3.54485 5.61218C3.22699 5.77407 2.96293 6.02469 2.78468 6.33366C2.60619 6.64244 2.52116 6.99639 2.5399 7.35255C2.55864 7.70872 2.68034 8.05179 2.89023 8.34014L3.59579 9.30959C3.8474 9.65562 3.9829 10.0725 3.98282 10.5003C3.9829 10.9282 3.8474 11.345 3.59579 11.6911L2.89023 12.6605C2.68034 12.9489 2.55864 13.2919 2.5399 13.6481C2.52116 14.0043 2.60619 14.3582 2.78468 14.667C2.96311 14.9758 3.2272 15.2263 3.54501 15.3882C3.86282 15.55 4.22072 15.6163 4.57542 15.579L5.76708 15.4522C6.19264 15.4075 6.62143 15.4986 6.99208 15.7124C7.36252 15.9262 7.65559 16.252 7.82912 16.6429Z"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path
            d="M9.99985 13.0003C11.3806 13.0003 12.4999 11.881 12.4999 10.5003C12.4999 9.11961 11.3806 8.00033 9.99985 8.00033C8.61914 8.00033 7.49985 9.11961 7.49985 10.5003C7.49985 11.881 8.61914 13.0003 9.99985 13.0003Z"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      ),
      path: '/settings',
      role: ['ADMIN', 'USER', 'SUPERADMIN'],
    },
  ] satisfies MenuItemInterface[] as MenuItemInterface[];

  return {
    all: [...firstMenu, ...secondMenu],
    firstMenu,
    secondMenu,
  };
};

export const TopMenu: FC = () => {
  const user = useUser();
  const { firstMenu, secondMenu } = useMenuItem();
  const { isGeneral, billingEnabled } = useVariables();
  return (
    <>
      <div className="flex flex-1 flex-col gap-[16px] blurMe">
        {
          // @ts-ignore
          user?.orgId &&
          // @ts-ignore
          (user.tier !== 'FREE' || !isGeneral || !billingEnabled) &&
          firstMenu
            .filter((f) => {
              if (f.hide) {
                return false;
              }
              if (f.requireBilling && !billingEnabled) {
                return false;
              }
              if (f.name === 'Billing' && user?.isLifetime) {
                return false;
              }
              if (f.role) {
                return f.role.includes(user?.role!);
              }
              return true;
            })
            .map((item, index) => (
              <MenuItem
                path={item.path}
                label={item.name}
                icon={item.icon}
                key={item.name}
              />
            ))
        }
      </div>
      <div className="flex flex-col gap-[16px] blurMe">
        {secondMenu
          .filter((f) => {
            if (f.hide) {
              return false;
            }
            if (f.requireBilling && !billingEnabled) {
              return false;
            }
            if (f.name === 'Billing' && user?.isLifetime) {
              return false;
            }
            if (f.role) {
              return f.role.includes(user?.role!);
            }
            return true;
          })
          .map((item, index) => (
            <MenuItem
              path={item.path}
              label={item.name}
              icon={item.icon}
              key={item.name}
            />
          ))}
      </div>
    </>
  );
};
