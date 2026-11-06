import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Outlet, RouterProvider, createBrowserRouter } from 'react-router';
import { Icon } from './components/Icon';
import { Spinner } from './components/ui';
import {
  AlbumPage,
  ArtistPage,
  CollectionPage,
  DownloadsPage,
  HomePage,
  LikedPage,
  NotFoundPage,
  PlaylistPage,
  RecentPage,
  SearchPage,
  SpotifyLikedPage,
} from './pages/Browse';
import { Layout } from './pages/Layout';
import { ChangePasswordPage, LoginPage } from './pages/Login';
import { SettingsPage } from './pages/Settings';
import { AuthProvider, useAuth } from './state';
import '@fontsource/figtree/400.css';
import '@fontsource/figtree/500.css';
import '@fontsource/figtree/700.css';
import '@fontsource/figtree/800.css';
import './styles.css';

function Gate() {
  const { state, loading, failed, refresh, mustChangePassword } = useAuth();
  if (loading && !state) {
    return (
      <div className="fullscreen-center">
        <Spinner size={32} />
      </div>
    );
  }
  if (failed && !state) {
    return (
      <div className="fullscreen-center">
        <Icon name="warning" size={40} />
        <p>Cannot reach the Reddify server.</p>
        <button className="btn" onClick={() => void refresh()}>
          Retry
        </button>
      </div>
    );
  }
  if (!state?.me) return <LoginPage />;
  if (mustChangePassword) return <ChangePasswordPage />;
  return <Outlet />;
}

const router = createBrowserRouter([
  {
    element: <Gate />,
    children: [
      {
        element: <Layout />,
        children: [
          { path: '/', element: <HomePage /> },
          { path: '/login', element: <HomePage /> },
          { path: '/search', element: <SearchPage /> },
          { path: '/album/:id', element: <AlbumPage /> },
          { path: '/artist/:id', element: <ArtistPage /> },
          { path: '/playlist/:id', element: <PlaylistPage /> },
          { path: '/collection', element: <CollectionPage /> },
          { path: '/collection/liked', element: <LikedPage /> },
          { path: '/collection/spotify', element: <SpotifyLikedPage /> },
          { path: '/collection/downloads', element: <DownloadsPage /> },
          { path: '/collection/recent', element: <RecentPage /> },
          { path: '/settings', element: <SettingsPage /> },
          { path: '/settings/:tab', element: <SettingsPage /> },
          { path: '*', element: <NotFoundPage /> },
        ],
      },
    ],
  },
]);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AuthProvider>
      <RouterProvider router={router} />
    </AuthProvider>
  </StrictMode>,
);
