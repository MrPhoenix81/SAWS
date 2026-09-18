import React from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider } from '@/context/AuthContext';
import { BulkTaskProvider } from '@/context/BulkTaskContext';
import ProtectedRoute from '@/components/ProtectedRoute';
import AppLayout from '@/components/AppLayout';
import Login from '@/pages/Login';
import ResetPassword from '@/pages/ResetPassword';
import Overview from '@/pages/Overview';
import ChangePassword from '@/pages/ChangePassword';
import Users from '@/pages/Users';
import Branches from '@/pages/Branches';
import Students from '@/pages/Students';
import Data from './pages/Data';
import SystemLinks from './pages/SystemLinks';
import Inactive from '@/pages/Inactive';
import Transfer from '@/pages/Transfer';
import NewEntry from '@/pages/NewEntry';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      staleTime: 30_000
    }
  }
});

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <BulkTaskProvider>
        <BrowserRouter>
          <Routes>
            <Route path="/login" element={<Login />} />
            <Route path="/reset-password" element={<ResetPassword />} />
            <Route
              element={
                <ProtectedRoute>
                  <AppLayout />
                </ProtectedRoute>
              }
            >
              <Route path="/" element={<Overview />} />
              <Route path="/students" element={<Students />} />
              <Route path="/inactive" element={<Inactive />} />
              <Route path="/transfer" element={<Transfer />} />
              <Route
                path="/new-entry"
                element={
                  <ProtectedRoute allowedRoles={['SCM']}>
                    <NewEntry />
                  </ProtectedRoute>
                }
              />
              <Route path="/change-password" element={<ChangePassword />} />
              <Route
                path="/admin/users"
                element={
                  <ProtectedRoute allowedRoles={['Admin', 'Head Office']}>
                    <Users />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/admin/branches"
                element={
                  <ProtectedRoute allowedRoles={['Admin']}>
                    <Branches />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/admin/data"
                element={
                  <ProtectedRoute allowedRoles={['Admin']}>
                    <Data />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/admin/links"
                element={
                  <ProtectedRoute allowedRoles={['Admin']}>
                    <SystemLinks />
                  </ProtectedRoute>
                }
              />
            </Route>
          </Routes>
        </BrowserRouter>
        </BulkTaskProvider>
      </AuthProvider>
    </QueryClientProvider>
  );
}