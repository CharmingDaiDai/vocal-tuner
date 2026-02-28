import { createBrowserRouter, RouterProvider, Navigate } from 'react-router-dom'
import Layout from './Layout'
import Home from '@/pages/Home'
import Library from '@/pages/Library'
import Karaoke from '@/pages/Karaoke'

const router = createBrowserRouter([
  {
    path: '/',
    element: <Layout />,
    children: [
      { index: true, element: <Navigate to="/home" replace /> },
      { path: 'home', element: <Home /> },
      { path: 'library', element: <Library /> },
      { path: 'karaoke/:jobId', element: <Karaoke /> },
    ],
  },
])

export default function AppRouter() {
  return <RouterProvider router={router} />
}
